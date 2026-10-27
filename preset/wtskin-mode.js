/**
 * The 「战雷画涂装模式」 preset's own child plugin.
 *
 * Services must be injected: touching ctx.systemPrompt directly throws during
 * activation, and a preset row that throws is reported as "never started" (the
 * Loader still accepts the declaration, so the failure is easy to miss).
 */
import { WTSKIN_PERSONA } from '../lib/persona.js';

export const name = 'dsh-wtskin-mode';

export function apply(ctx) {
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: 'wtskin:mode',
      order: 5,
      text: WTSKIN_PERSONA,
    });
  });
}
