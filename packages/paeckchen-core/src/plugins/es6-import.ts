import * as ESTree from 'estree';
import { visit, builders as b, namedTypes as n, Path } from 'ast-types';

import { getModuleIndex, enqueueModule } from '../modules';
import { getModulePath } from '../module-path';
import { PaeckchenContext } from '../bundle';
import { State } from '../state';

export function rewriteImportDeclaration(program: ESTree.Program, currentModule: string,
    context: PaeckchenContext, state: State): Promise<void> {
  return Promise.resolve()
    .then(() => {
      context.logger.trace('plugin', `rewriteImportDeclaration [currentModule=${currentModule}]`);
    })
    .then(() => {
      const updates: [string, Path<ESTree.ImportDeclaration>][] = [];

      visit(program, {
        visitImportDeclaration: function(path: Path<ESTree.ImportDeclaration>): boolean {
          updates.push([path.node.source.value as string, path]);
          return false;
        },
        visitStatement: function(): boolean {
          // es2015 imports are only allowed at the top level of a module
          // => we could stop here
          return false;
        }
      });

      return Promise.all(updates.map(update => {
        const [importPath, path] = update;
        return getModulePath(currentModule, importPath, context)
          .then(importModule => {
            const importModuleIndex = getModuleIndex(importModule, state);
            replaceImports(path, importModuleIndex);
            enqueueModule(importModule, state, context);
          });
      }));
    });
}

function convertImport(tempIdentifier: ESTree.Identifier, specifier: ESTree.ImportSpecifier
    | ESTree.ImportDefaultSpecifier | ESTree.ImportNamespaceSpecifier): ESTree.VariableDeclarator {
  if (n.ImportSpecifier.check(specifier)) {
    // e.g. import { a as b, c } from './dep';
    return b.variableDeclarator(
      b.identifier(specifier.local.name),
      b.memberExpression(
        b.memberExpression(
          tempIdentifier,
          b.identifier('exports'),
          false
        ),
        b.literal(specifier.imported.name),
        true
      )
    );
  } else if (n.ImportDefaultSpecifier.check(specifier)) {
    // e.g. import dep from './dep';
    return b.variableDeclarator(
      b.identifier(specifier.local.name),
      b.memberExpression(
        b.memberExpression(
          tempIdentifier,
          b.identifier('exports'),
          false
        ),
        b.literal('default'),
        true
      )
    );
  }
  // e.g. import * as dep from './dep';
  return b.variableDeclarator(
    b.identifier((specifier as ESTree.ImportNamespaceSpecifier).local.name),
    b.memberExpression(
      tempIdentifier,
      b.identifier('exports'),
      false
    )
  );
}

function replaceImports(path: Path<ESTree.ImportDeclaration>, importModuleIndex: number): void {
  const tempIdentifier = path.scope.declareTemporary(`__import${importModuleIndex}`);
  const imports = path.node.specifiers.map((specifier) => convertImport(tempIdentifier, specifier));
  path.replace(
    b.variableDeclaration(
      'var',
      [
        b.variableDeclarator(
          tempIdentifier,
          b.callExpression(
            b.identifier('__paeckchen_require__'),
            [
              b.literal(importModuleIndex)
            ]
          )
        ),
        ...imports
      ]
    )
  );
}
