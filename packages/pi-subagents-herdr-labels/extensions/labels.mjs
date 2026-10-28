import { basename } from 'node:path';

// Only adapt the upstream Herdr metadata writer; no model tools or agent state changes.
export function filterHerdrLabels(command, args, env = process.env) {
  const isHerdr = basename(command) === 'herdr' || command === env.HERDR_BIN;
  if (!isHerdr || args[0] !== 'pane' || args[1] !== 'report-metadata') return args;
  const sourceIndex = args.indexOf('--source');
  if (sourceIndex < 0 || args[sourceIndex + 1] !== 'pi-subagents:herdr' || !args.includes('--state-label')) return args;
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-label') { i++; continue; }
    filtered.push(args[i]);
  }
  // Remove labels left by the unadapted bridge once this session next publishes.
  // This clears only pi-subagents:herdr, not local.pane-id or approval reasons.
  filtered.push('--clear-state-labels');
  return filtered;
}

export function registerWithHerdrLabels(pi, register) {
  const adapted = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === 'exec') return (command, args, options) => target.exec(command, filterHerdrLabels(command, args), options);
      return Reflect.get(target, property, receiver);
    },
  });
  return register(adapted);
}
