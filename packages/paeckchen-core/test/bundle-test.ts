import test from 'ava';
import { HostMock, virtualModule } from './helper';
import { State } from '../src/state';

import { bundle, rebundleFactory, IPaeckchenContext, IBundleOptions } from '../src/bundle';

test('bundle should bundle the given entry-point and its dependencies', t => {
  const host = new HostMock({
    'entry-point.js': `
      import fn from './dependency';
      fn();
    `,
    './dependency.js': `
      export default function() {
        callme();
      }
    `
  });

  let bundled: string;
  bundle({entryPoint: 'entry-point.js'}, host, result => bundled = result);

  let called = false;
  virtualModule(bundled, {
    callme: function(): void {
      called = true;
    }
  });
  t.true(called);
});

test('bundle should bundle global dependencies', t => {
  const host = new HostMock({
    '/entry-point.js': `
      Buffer.isBuffer();
    `,
    'BUFFER': `
      export const Buffer = {
        isBuffer() {
          callme();
        }
      };
    `
  }, '/');
  const config: IBundleOptions = {
    entryPoint: '/entry-point.js',
    alias: 'buffer=/BUFFER'
  };

  let bundled: string;
  bundle(config, host, result => bundled = result);

  let called = false;
  virtualModule(bundled, {
    callme: function(): void {
      called = true;
    }
  });
  t.true(called);
});

test('bundle should check for a config-file', t => {
  const host = new HostMock({
    '/entry-point.js': `
      callback();
    `,
    '/paeckchen.json': JSON.stringify({
        input: {
          entry: './entry-point'
        }
      })
  }, '/');

  let bundled: string;
  bundle({}, host, result => bundled = result);

  let called = false;
  virtualModule(bundled, {
    callback: function(): void {
      called = true;
    }
  });
  t.true(called);
});

test('bundle should throw if no entry-point configured', t => {
  const host = new HostMock({
    '/paeckchen.json': '{}'
  }, '/');

  t.throws(() => bundle({}, host), 'Missing entry-point');
});

test('bundle should write result to disk if output file given', t => {
  const host = new HostMock({
    '/paeckchen.json': JSON.stringify({
      input: {
        entry: './entry-point'
      },
      output: {
        file: 'result.js'
      }
    }),
    '/entry-point': `console.log("foo");`
  }, '/');

  bundle({}, host);

  t.true('/result.js' in host.files);
});

test.cb('rebundleFactory should return a function which calls a bundle function on the end of the event loop', t => {
  const state = new State([]);
  const ast: any = {};
  const context: any = {};
  let bundleFunctionCalled = 0;
  const bundleFunction: any = (_state: any, _ast: any, _context: any) => {
    t.is(_state, state);
    t.is(_ast, ast);
    t.is(_context, context);
    bundleFunctionCalled++;
  };
  const rebundle = rebundleFactory(state, ast, context, bundleFunction, () => undefined);
  rebundle();
  rebundle();

  setTimeout(() => {
    t.is(bundleFunctionCalled, 1);
    t.end();
  }, 25);
});

test('bundle should create a watch and a rebundle function when in watch mode', t => {
  const host = new HostMock({
    '/entry': ''
  }, '/');
  let bundleFunctionCalled = 0;
  const rebundle = () => {
    //
  };
  const bundleFunction: any = (ast: any, modules: any, context: IPaeckchenContext) => {
    t.truthy(context.watcher);
    t.is(context.rebundle, rebundle);
    bundleFunctionCalled++;
  };
  const rebundleFactoryFunction: any = () => {
    return rebundle;
  };
  const config: IBundleOptions = {
    entryPoint: '/entry',
    watchMode: true
  };

  bundle(config, host, () => undefined, bundleFunction, rebundleFactoryFunction);

  t.is(bundleFunctionCalled, 1);
});