import * as ESTree from 'estree';
import { join } from 'path';
import { parse } from 'acorn';
import { generate } from 'escodegen';

import { Host, DefaultHost } from './host';
import { getModulePath } from './module-path';
import { enqueueModule, bundleNextModules } from './modules';
import { injectGlobals } from './globals';
import { createConfig, Config } from './config';
import { State } from './state';
import { Watcher, FSWatcher } from './watcher';
import { ProgressStep, Logger, NoopLogger } from './logger';
import { updateCache, readCache } from './cache';
import { generateSourceMap } from './source-map';

export type SourceOptions =
    'es5'
  | 'es6' | 'es2015';

export interface BundleOptions {
  configFile?: string;
  entryPoint?: string;
  source?: SourceOptions;
  outputDirectory?: string;
  outputFile?: string;
  runtime?: string;
  alias?: string|string[];
  external?: string|string[];
  watchMode?: boolean;
  logger?: Logger;
  sourceMap?: boolean|'inline';
  logLevel?: 'default' | 'debug' | 'trace';
  debug?: boolean;
}

export interface PaeckchenContext {
  config: Config;
  host: Host;
  watcher?: Watcher;
  rebundle?: () => void;
  logger: Logger;
}

function getModules(ast: ESTree.Program): ESTree.ArrayExpression {
  return (ast.body[2] as ESTree.VariableDeclaration).declarations[0].init as ESTree.ArrayExpression;
}

const paeckchenSource = `
  var __paeckchen_cache__ = [];
  function __paeckchen_require__(index) {
    if (!(index in __paeckchen_cache__)) {
      __paeckchen_cache__[index] = {
        module: {
          exports: {}
        }
      };
      modules[index](__paeckchen_cache__[index].module, __paeckchen_cache__[index].module.exports);
    }
    return __paeckchen_cache__[index].module;
  }
  var modules = [];
  __paeckchen_require__(0);
`;

export type BundleChunkFunction = typeof bundleChunks;
/**
 * Recursivly bundle chunks of modules wich are enqueued.
 */
export function bundleChunks(step: ProgressStep, state: State, context: PaeckchenContext): Promise<void> {
  const fns = bundleNextModules(state, context);
  if (fns.length > 0) {
    let num = fns.length - 1;
    return Promise.all(fns.map(fn => {
        return fn.then(() => {
          num--;
          context.logger.progress(step, state.moduleBundleQueue.length + num, state.modules.length);
        });
      }))
      .then(() => bundleChunks(step, state, context));
  }
  return Promise.resolve();
};

export type BundlingFunction = typeof executeBundling;
/**
 * Bundle a complete paeckchen in the following steps:
 *
 * * init bundling
 * * process modules
 * * inject global code
 * * process global dependencies
 * * create source-map
 * * output result
 */
export function executeBundling(state: State, paeckchenAst: ESTree.Program, context: PaeckchenContext,
    outputFunction: OutputFunction, bundleChunkFunction: BundleChunkFunction = bundleChunks): void {
  context.logger.progress(ProgressStep.init, state.moduleBundleQueue.length, state.modules.length);

  function outputAndCache(code: string, sourceMap?: string): void {
    context.logger.progress(ProgressStep.end, state.moduleBundleQueue.length, state.modules.length);
    outputFunction(null, context, code, sourceMap);
    if (context.config.debug) {
      updateCache(context, paeckchenAst, state);
    }
  }

  bundleChunks(ProgressStep.bundleModules, state, context)
    .then(() => injectGlobals(state, paeckchenAst, context))
    .then(() => bundleChunks(ProgressStep.bundleGlobals, state, context))
    .then(() => {
        context.logger.progress(ProgressStep.generateBundle, state.moduleBundleQueue.length, state.modules.length);
        const bundleResult = generate(paeckchenAst, {
          comment: true,
          sourceMap: Boolean(context.config.output.sourceMap),
          sourceMapWithCode: Boolean(context.config.output.sourceMap)
        });

        if (typeof bundleResult === 'string') {
          outputAndCache(bundleResult, undefined);
        } else {
          context.logger.progress(ProgressStep.generateSourceMap, state.moduleBundleQueue.length, state.modules.length);
          generateSourceMap(state, context, bundleResult)
            .then(sourceMap => outputAndCache(bundleResult.code, sourceMap));
        }
      })
    .catch(error => {
      outputFunction(error, context);
    });
}

export type RebundleFactory = typeof rebundleFactory;
export function rebundleFactory(state: State, paeckchenAst: ESTree.Program, context: PaeckchenContext,
    bundleFunction: BundlingFunction, outputFunction: OutputFunction): () => void {
  let timer: NodeJS.Timer;
  return function rebundle(): void {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      try {
        context.logger.trace('bundle', `rebundle`);
        bundleFunction(state, paeckchenAst, context, outputFunction);
      } catch (e) {
        outputFunction(e, context);
      }
    }, 0);
  };
}

export interface OutputFunction {
  (error: Error|null, context: PaeckchenContext|undefined, code?: string, sourceMap?: string|undefined): void;
}

function createContext(config: Config, host: Host, options: BundleOptions): PaeckchenContext {
  const context: PaeckchenContext = {
    config,
    host,
    logger: options.logger || new NoopLogger()
  };
  context.logger.configure(config);
  if (!context.config.input.entryPoint) {
    throw new Error('Missing entry-point');
  }
  if (context.config.watchMode) {
    context.watcher = host.createWatcher && host.createWatcher() || new FSWatcher();
  }
  return context;
}

export function bundle(options: BundleOptions, host: Host = new DefaultHost(), outputFunction: OutputFunction,
    bundleFunction: BundlingFunction = executeBundling,
      rebundleFactoryFunction: RebundleFactory = rebundleFactory): void {
  createConfig(options, host)
    .then(config => {
      const context = createContext(config, host, options);
      return readCache(context)
        .then(cache => {
          const paeckchenAst = cache.paeckchenAst || parse(paeckchenSource);
          const state = new State(getModules(paeckchenAst).elements as ESTree.Expression[]);
          if (cache.state) {
            return state.load(context, cache.state)
              .then(() => {
                if (context.config.watchMode) {
                  Object.keys(state.wrappedModules).forEach(file => {
                    (context.watcher as Watcher).watchFile(file);
                  });
                }
                return { paeckchenAst, state };
              });
          }
          return { paeckchenAst, state };
        })
        .then(({paeckchenAst, state}) => {
          const absoluteEntryPath = join(host.cwd(), context.config.input.entryPoint);

          return getModulePath('.', absoluteEntryPath, context)
            .then(modulePath => {
              enqueueModule(modulePath, state, context);
              if (context.config.watchMode) {
                context.rebundle = rebundleFactoryFunction(state, paeckchenAst, context, bundleFunction,
                  outputFunction);
              }
              bundleFunction(state, paeckchenAst, context, outputFunction);
            });
        })
        .catch(error => {
          outputFunction(error, context);
        });
    })
    .catch(error => {
      outputFunction(error, undefined);
    });
}
