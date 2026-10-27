/**
 * The 「战雷画涂装模式」 preset's own child plugin.
 *
 * Preset rows are resolved from the profile, where the shipped @deepseek-ai
 * plugins do not exist; absolute paths into app.asar are accepted by the Loader
 * but their modules never start. A real file inside this package does start, so
 * the mode contributes its prompt from here.
 */
import { WTSKIN_PERSONA } from '../lib/persona.js';

export const name = 'dsh-wtskin-mode';

export function apply(ctx) {
  ctx.systemPrompt?.section?.({
    name: 'wtskin:mode',
    order: 5,
    text: WTSKIN_PERSONA,
  });
}
