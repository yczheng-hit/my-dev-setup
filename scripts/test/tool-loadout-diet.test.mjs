import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHiddenDeclarations,
  createToolLoadoutDietController,
  deriveToolLoadoutState,
} from '../../pi/extensions/tool-loadout-diet.ts';

const ALL_DECLARED_TOOLS = [
  'read',
  'bash',
  'write',
  'replace',
  'replace_match',
  'insert',
  'copy',
  'move',
  'grep',
  'undo_last_change',
  'questionnaire',
  'question',
  'todo',
  'update_plan',
  'obs_recall',
  'context_recall',
  'context_compact',
  'context_checkpoint',
  'context_timeline',
  'ExitPlanMode',
  'goal_complete',
  'goal_blocked',
  'goal_wait',
  'review_run',
  'review_output',
  'web_search',
  'source_check',
  'fetch_content',
  'get_search_content',
  'schedule_task',
  'manage_scheduled_task',
  'list_scheduled_tasks',
  'cancel_scheduled_task',
  'bg_list',
  'bg_output',
  'bg_stop',
];

test('computeHiddenDeclarations hides mode-inactive, follow-up, and redundant tools by default', () => {
  const hidden = computeHiddenDeclarations(ALL_DECLARED_TOOLS, {
    planModeActive: false,
    goalModeActive: false,
    piContextUsed: false,
    reviewOutputActive: false,
    webSearchUsed: false,
    schedulerManagementActive: false,
    bgTasksActive: false,
    obsRecallAvailable: false,
    contextRecallAvailable: false,
  });

  assert.deepEqual(hidden, [
    'ExitPlanMode',
    'goal_complete',
    'goal_blocked',
    'goal_wait',
    'context_compact',
    'context_checkpoint',
    'context_timeline',
    'question',
    'todo',
    'review_output',
    'get_search_content',
    'manage_scheduled_task',
    'list_scheduled_tasks',
    'cancel_scheduled_task',
    'bg_list',
    'bg_output',
    'bg_stop',
    'obs_recall',
    'context_recall',
  ]);
});

test('computeHiddenDeclarations exposes ExitPlanMode in plan mode and goal tools in goal mode', () => {
  const hiddenInPlan = computeHiddenDeclarations(ALL_DECLARED_TOOLS, {
    planModeActive: true,
    goalModeActive: false,
    piContextUsed: false,
    reviewOutputActive: false,
    webSearchUsed: false,
    schedulerManagementActive: false,
    bgTasksActive: false,
    obsRecallAvailable: false,
    contextRecallAvailable: false,
  });
  assert.equal(hiddenInPlan.includes('ExitPlanMode'), false);
  assert.equal(hiddenInPlan.includes('goal_complete'), true);

  const hiddenInGoal = computeHiddenDeclarations(ALL_DECLARED_TOOLS, {
    planModeActive: false,
    goalModeActive: true,
    piContextUsed: false,
    reviewOutputActive: true,
    webSearchUsed: true,
    schedulerManagementActive: true,
    bgTasksActive: true,
    obsRecallAvailable: true,
    contextRecallAvailable: true,
  });
  assert.equal(hiddenInGoal.includes('goal_complete'), false);
  assert.equal(hiddenInGoal.includes('goal_blocked'), false);
  assert.equal(hiddenInGoal.includes('goal_wait'), false);
  assert.equal(hiddenInGoal.includes('review_output'), false);
  assert.equal(hiddenInGoal.includes('get_search_content'), false);
  assert.equal(hiddenInGoal.includes('manage_scheduled_task'), false);
  assert.equal(hiddenInGoal.includes('bg_output'), false);
  assert.equal(hiddenInGoal.includes('obs_recall'), false);
  assert.equal(hiddenInGoal.includes('context_recall'), false);
});

test('deriveToolLoadoutState tracks plan mode, goal state, search, scheduler, bg tasks, and recall IDs from branch entries', () => {
  const defaultState = deriveToolLoadoutState([
    { type: 'custom', customType: 'modes', data: { mode: 'bypassPermissions' } },
  ]);
  assert.deepEqual(defaultState, {
    planModeActive: false,
    goalModeActive: false,
    piContextUsed: false,
    reviewOutputActive: false,
    webSearchUsed: false,
    schedulerManagementActive: false,
    bgTasksActive: false,
    obsRecallAvailable: false,
    contextRecallAvailable: false,
  });

  const activeState = deriveToolLoadoutState([
    { type: 'custom', customType: 'modes', data: { mode: 'plan' } },
    { type: 'custom', customType: 'goal-state', data: { goal: { id: 'g1', status: 'active' } } },
    { type: 'compaction', summary: 'ctx_1234' },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc1', name: 'review_run', arguments: {} },
          { type: 'toolCall', id: 'tc2', name: 'web_search', arguments: {} },
          { type: 'toolCall', id: 'tc3', name: 'schedule_task', arguments: {} },
        ],
      },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: 'Command auto-backgrounded... obs_abc123' }],
      },
    },
  ]);
  assert.deepEqual(activeState, {
    planModeActive: true,
    goalModeActive: true,
    piContextUsed: false,
    reviewOutputActive: true,
    webSearchUsed: true,
    schedulerManagementActive: true,
    bgTasksActive: true,
    obsRecallAvailable: true,
    contextRecallAvailable: true,
  });
});

test('controller wires prepareLoadout and refreshes hidden declarations on mode and tool changes', async () => {
  const handlers = new Map();
  let registeredTool = null;
  let activeTools = [...ALL_DECLARED_TOOLS];
  let setActiveCalls = 0;

  const pi = {
    on(event, fn) {
      handlers.set(event, fn);
    },
    registerTool(tool) {
      registeredTool = tool;
    },
    getFlag() {
      return undefined;
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(next) {
      activeTools = [...next];
      setActiveCalls += 1;
    },
  };

  const diet = createToolLoadoutDietController(pi);
  registeredTool = {
    name: 'questionnaire',
    prepareLoadout: (loadout) => diet.prepareLoadout(loadout),
  };
  assert.ok(registeredTool?.prepareLoadout);

  const branch = [{ type: 'custom', customType: 'modes', data: { mode: 'bypassPermissions' } }];
  const ctx = {
    sessionManager: {
      getBranch: () => branch,
    },
  };

  handlers.get('session_start')({}, ctx);
  assert.equal(setActiveCalls, 1);

  const initialChanges = registeredTool.prepareLoadout({
    declared: ALL_DECLARED_TOOLS.map((name) => ({ name })),
  });
  assert.equal(initialChanges.hiddenDeclarations.includes('ExitPlanMode'), true);
  assert.equal(initialChanges.hiddenDeclarations.includes('goal_complete'), true);
  assert.equal(initialChanges.hiddenDeclarations.includes('review_output'), true);
  assert.equal(initialChanges.hiddenDeclarations.includes('get_search_content'), true);
  assert.equal(initialChanges.hiddenDeclarations.includes('manage_scheduled_task'), true);
  assert.equal(initialChanges.hiddenDeclarations.includes('bg_output'), true);

  // Trigger web_search and bash background task
  handlers.get('tool_execution_start')({ toolName: 'web_search', args: {} });
  handlers.get('tool_execution_start')({ toolName: 'bash', args: { run_in_background: true } });

  // Switch into plan mode and active goal
  branch.push({ type: 'custom', customType: 'modes', data: { mode: 'plan' } });
  branch.push({ type: 'custom', customType: 'goal-state', data: { goal: { id: 'g-1', status: 'active' } } });
  handlers.get('before_agent_start')({ prompt: 'plan this task and check scheduled tasks' }, ctx);

  const updatedChanges = registeredTool.prepareLoadout({
    declared: ALL_DECLARED_TOOLS.map((name) => ({ name })),
  });
  assert.equal(updatedChanges.hiddenDeclarations.includes('ExitPlanMode'), false);
  assert.equal(updatedChanges.hiddenDeclarations.includes('goal_complete'), false);
  assert.equal(updatedChanges.hiddenDeclarations.includes('get_search_content'), false);
  assert.equal(updatedChanges.hiddenDeclarations.includes('bg_output'), false);
  assert.equal(updatedChanges.hiddenDeclarations.includes('manage_scheduled_task'), false);
});
