import { parse } from 'acorn';
import { builders as b } from 'ast-types';

import { PaeckchenContext } from './bundle';
import * as defaultPlugins from './plugins';
import { Plugins } from './plugins';
import { checkGlobals } from './globals';
import { WrappedModule, State } from './state';
import { wrapJsonFile } from './bundle-json';

export function getModuleIndex(moduleName: string, state: State): number {
  if (state.wrappedModules[moduleName]) {
    return state.wrappedModules[moduleName].index;
  }
  const index = state.getAndIncrementModuleIndex();
  state.wrappedModules[moduleName] = {
    index,
    name: moduleName,
    remove: false,
    mtime: -1
  };
  return index;
}

export function updateModule(moduleName: string, remove: boolean, state: State): void {
  if (state.wrappedModules[moduleName]) {
    state.wrappedModules[moduleName].ast = undefined;
    state.wrappedModules[moduleName].remove = remove;
  }
}

function createModuleWrapper(context: PaeckchenContext, name: string, moduleAst: ESTree.Program,
    state: State): Promise<WrappedModule> {
  context.logger.trace('module', `createModuleWrapper [name=${name}]`);
  const index = getModuleIndex(name, state);
  return context.host.getModificationTime(name)
    .then(mtime => {
      return {
        index,
        name,
        ast: b.functionExpression(
          b.identifier(`_${index}`),
          [
            b.identifier('module'),
            b.identifier('exports')
          ],
          b.blockStatement(
            moduleAst.body
          )
        ),
        remove: false,
        mtime
      };
    });
}

export function enqueueModule(modulePath: string, state: State, context: PaeckchenContext): void {
  context.logger.trace('module', `enqueueModule [modulePath=${modulePath}]`);
  if (state.moduleBundleQueue.indexOf(modulePath) === -1) {
    state.moduleBundleQueue.push(modulePath);
  }
}

export function bundleNextModules(state: State, context: PaeckchenContext,
    plugins: any = defaultPlugins): Promise<void>[] {
  if (state.moduleBundleQueue.length === 0) {
    return [];
  }
  const modules = state.moduleBundleQueue.splice(0);
  return modules.map(modulePath => {
    context.logger.debug('module', `bundle ${modulePath}`);
    return watchModule(state, modulePath, context)
      .then(() => wrapModule(modulePath, state, context, plugins));
  });
}

function watchModule(state: State, modulePath: string, context: PaeckchenContext): Promise<void> {
  return Promise.resolve()
    .then(() => {
      context.logger.trace('module', `watchModule [modulePath=${modulePath}]`);
    })
    .then(() => {
      if (context.config.watchMode) {
        if (!state.moduleWatchCallbackAdded) {
          state.moduleWatchCallbackAdded = true;
          if (context.watcher) {
            context.watcher.start((event) => {
              let rebundle = false;
              if (event === 'update') {
                updateModule(modulePath, false, state);
                enqueueModule(modulePath, state, context);
                rebundle = true;
              } else if (event === 'remove') {
                updateModule(modulePath, true, state);
                enqueueModule(modulePath, state, context);
                rebundle = true;
              }
              if (rebundle && context.rebundle) {
                context.rebundle();
              }
            });
          }
        }
        if (context.watcher) {
          context.watcher.watchFile(modulePath);
        }
      }
    });
}

function wrapModule(modulePath: string, state: State, context: PaeckchenContext, plugins: any): Promise<void> {
  return Promise.resolve()
    .then(() => {
      context.logger.trace('module', `wrapModule [modulePath=${modulePath}]`);
    })
    .then(() => {
      // Prefill index
      getModuleIndex(modulePath, state);
      return state.wrappedModules[modulePath].ast !== undefined;
    })
    .then(upToDate => {
      if (!upToDate) {
        return Promise.resolve()
          .then(() => {
            if (!state.wrappedModules[modulePath].remove) {
              let promisedModuleAst: Promise<ESTree.Program>;
              if (Object.keys(context.config.externals).indexOf(modulePath) !== -1) {
                promisedModuleAst = wrapExternalModule(modulePath, context);
              } else if (!context.host.fileExists(modulePath)) {
                promisedModuleAst = wrapMissingModule(modulePath);
              } else if (modulePath.match(/\.json$/)) {
                promisedModuleAst = wrapJsonFile(modulePath, context);
              } else {
                promisedModuleAst = processModule(modulePath, context, state, plugins);
              }
              return promisedModuleAst
                .then(moduleAst => createModuleWrapper(context, modulePath, moduleAst, state))
                .then(wrappedModule => {
                  state.wrappedModules[modulePath] = wrappedModule;
                  return state.wrappedModules[modulePath].ast;
                });
            } else {
              return wrapThrowOnRemovedModule(modulePath);
            }
          })
          .then(moduleAst => {
            const moduleIndex = getModuleIndex(modulePath, state);
            state.modules[moduleIndex] = moduleAst as ESTree.Statement;
          })
          .catch(e => {
            context.logger.error('module', e, `Failed to process module '${modulePath}'`);
            throw e;
          });
      }
      return undefined;
    });

}

function wrapMissingModule(modulePath: string): Promise<ESTree.Program> {
  return Promise.resolve(b.program([
    b.throwStatement(
      b.newExpression(
        b.identifier('Error'),
        [
          b.literal(`Module '${modulePath}' not found`)
        ]
      )
    )
  ]));
}

function wrapThrowOnRemovedModule(modulePath: string): Promise<ESTree.Statement> {
  return Promise.resolve(b.throwStatement(
    b.newExpression(
      b.identifier('Error'),
      [
        b.literal(`Module '${modulePath}' was removed`)
      ]
    )
  ));
}

function wrapExternalModule(modulePath: string, context: PaeckchenContext): Promise<ESTree.Program> {
  const external = context.config.externals[modulePath] === false
    ? b.objectExpression([])
    : b.identifier(context.config.externals[modulePath] as string);
  return Promise.resolve(b.program([
    b.expressionStatement(
      b.assignmentExpression(
        '=',
        b.memberExpression(
          b.identifier('module'),
          b.identifier('exports'),
          false
        ),
        external
      )
    )
  ]));
}

function processModule(modulePath: string, context: PaeckchenContext, state: State,
    plugins: Plugins): Promise<ESTree.Program> {
  context.logger.trace('module', `processModule [modulePath=${modulePath}]`);
  return context.host.readFile(modulePath)
    .then(code => {
      // parse...
      const moduleAst = parse(code, {
        ecmaVersion: 7,
        sourceType: 'module',
        locations: true,
        ranges: true,
        sourceFile: modulePath,
        allowHashBang: true
      });

      // ... check for global features...
      checkGlobals(state, moduleAst);

      // ... and rewrite ast
      return Promise
        .all(Object.keys(plugins).map(plugin => {
          return plugins[plugin](moduleAst, modulePath, context, state);
        }))
        .then(() => moduleAst);

    });
}
