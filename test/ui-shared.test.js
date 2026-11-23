import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadSharedUi() {
  const source = fs.readFileSync(path.join(rootDir, 'ui', 'shared.js'), 'utf8');
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'ui/shared.js' });
  return sandbox.CursorBridgeUI;
}

test('ui/shared.js normalizes aliases, preserves unrelated plugin options, and clears legacy keys', () => {
  const ui = loadSharedUi();
  const formState = ui.readOptionsToFormState({
    autoModel: 'magpie/router-mini[reasoning=low]',
    subagent: 'magpie/legacy-sub',
    bugbotModel: 'magpie/bug-pro[reasoning=high]',
    security: 'magpie/sec-opus',
    namingModel: 'magpie/title-mini',
    summary: 'magpie/sum-mid',
    memoriesModel: 'magpie/mem-fast',
    commitModel: 'magpie/commit-mini',
    subagentTypes: { explore: 'magpie/explore-fast' },
    servicePort: 19999,
  });
  assert.equal(formState.roles.autoRouter, 'magpie/router-mini[reasoning=low]');
  assert.equal(formState.roles.subagent, 'magpie/legacy-sub');
  assert.equal(formState.roles.bugbot, 'magpie/bug-pro[reasoning=high]');
  assert.equal(formState.roles.securitybot, 'magpie/sec-opus');
  assert.equal(formState.roles.title, 'magpie/title-mini');
  assert.equal(formState.roles.summarize, 'magpie/sum-mid');
  assert.equal(formState.roles.memory, 'magpie/mem-fast');
  assert.equal(formState.roles.commit, 'magpie/commit-mini');
  assert.deepEqual(JSON.parse(JSON.stringify(formState.subagentTypes)), {
    explore: 'magpie/explore-fast',
  });

  const builtOptions = ui.buildOptionsPayload(
    { autoModel: 'magpie/router-mini', subagent: 'magpie/legacy-sub', servicePort: 19999, customNote: 'keep' },
    {
      roles: {
        autoRouter: 'cursor/auto',
        subagent: '',
        bugbot: 'magpie/bug-pro[reasoning=high]',
        securitybot: 'magpie/sec-opus',
        title: 'magpie/title-mini',
        summarize: 'magpie/sum-mid',
        memory: 'magpie/mem-fast',
        commit: '',
      },
      subagentTypes: { explore: 'magpie/explore-fast' },
    }
  );
  assert.equal('autoModel' in builtOptions, false);
  assert.equal('subagent' in builtOptions, false);
  assert.equal('roles' in builtOptions, false);
  assert.equal('subagentTypes' in builtOptions, false);
  assert.equal(builtOptions.servicePort, 19999);
  assert.equal(builtOptions.customNote, 'keep');
  assert.equal(builtOptions.autoRouterModel, 'cursor/auto');
  assert.equal(builtOptions.subagentModel, '');
  assert.equal(builtOptions.bugbotModel, 'magpie/bug-pro[reasoning=high]');
  assert.deepEqual(JSON.parse(JSON.stringify(builtOptions.subagentTypeModels)), {
    explore: 'magpie/explore-fast',
  });

  const rolesPayload = ui.buildServiceRolesPayload(formState);
  assert.equal(rolesPayload.autoRouter, 'magpie/router-mini[reasoning=low]');
  assert.equal(rolesPayload.securitybot, 'magpie/sec-opus');
  assert.deepEqual(JSON.parse(JSON.stringify(rolesPayload.subagentTypes)), {
    explore: 'magpie/explore-fast',
  });
});

test('all ui/*.js files parse cleanly without syntax errors', () => {
  for (const fileName of ['shared.js', 'panel.js', 'page.js', 'service.js']) {
    const source = fs.readFileSync(path.join(rootDir, 'ui', fileName), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: `ui/${fileName}` }));
  }
});
