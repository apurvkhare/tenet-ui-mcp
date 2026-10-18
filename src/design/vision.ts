// Perception (DESIGN.md §2 "Perception", §8 "Vision without sampling"): opt-in, and the only model
// call the server can make. By default the agent's own model, which already sees the screenshot,
// describes it as a layout tree and the server makes no model call: no operator spend, no user
// screenshot sent to a provider the user did not choose. An internal deployment that wants the
// server to read images sets VISION=on with its own credentials and model. One fixed template,
// design content in the user turn only, output constrained to the layout schema in the catalog's
// vocabulary.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ToolError } from '../tools/context.js';
import { LAYOUT_RULES, VisionLayoutSchema, type Layout } from './layout.js';

export interface VisionInput {
  image: Buffer;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  vocabulary: { components: string[]; tokenGroups: string[]; icons: number };
  hints?: { name?: string; notes?: string; viewport?: { width: number; height: number } };
}
export interface VisionResult {
  layout: Layout;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}
export type VisionFn = (input: VisionInput) => Promise<VisionResult>;

const SYSTEM = ['You analyse a screenshot of a user interface and describe it as a layout tree for a design-system server.', ...LAYOUT_RULES].join('\n');

export const DEFAULT_VISION_MODEL = 'claude-opus-5-5';

/**
 * Vision is on only when VISION=on. A model key alone does not turn it on, so an ANTHROPIC_API_KEY
 * that happens to be in the environment (a developer shell, a shared CI secret) never starts
 * server-side model calls on users' screenshots. Credentials come from the SDK's usual sources
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, an `ant auth login` profile).
 */
export function visionFromEnv(env: NodeJS.ProcessEnv = process.env): { vision?: VisionFn; status: string } {
  const model = env.VISION_MODEL ?? DEFAULT_VISION_MODEL;
  if (env.VISION === 'on') return { vision: createVision(model), status: `on (${model})` };
  const key = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  return { status: `off: the agent describes the layout${key ? '; a model key is set but VISION=on is not' : ''}` };
}

export function createVision(model = process.env.VISION_MODEL ?? DEFAULT_VISION_MODEL): VisionFn {
  const client = new Anthropic();
  return async (input) => {
    const vocabulary = `Design-system component ids: ${input.vocabulary.components.join(', ')}.\nToken groups: ${input.vocabulary.tokenGroups.join(', ')}.\nIcon set: ${input.vocabulary.icons} icons.`;
    const hints = [input.hints?.name ? `The screen is called "${input.hints.name}".` : '', input.hints?.viewport ? `The image is ${input.hints.viewport.width}×${input.hints.viewport.height} px.` : '', input.hints?.notes ? `Notes from the host: ${input.hints.notes}` : ''].filter(Boolean).join(' ');
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.image.toString('base64') } },
            { type: 'text', text: `${vocabulary}\n${hints}\nDescribe this screenshot as a layout tree.` },
          ],
        }],
        output_config: { format: betaZodOutputFormat(VisionLayoutSchema) },
      });
      if (response.stop_reason === 'refusal') throw new ToolError('the vision model declined this image', 'vision_refused');
      const parsed = response.parsed_output;
      if (!parsed) throw new ToolError('the vision model returned no parseable layout; retry, or describe the screenshot yourself and pass source.type "layout" with the image', 'vision_unparseable');
      return { layout: parsed, model: response.model, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
    } catch (err) {
      if (err instanceof ToolError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new ToolError('vision is on but has no model credentials on this server; describe the screenshot yourself and pass source.type "layout" with the image', 'vision_unavailable');
      if (err instanceof Anthropic.RateLimitError) throw new ToolError('vision provider rate-limited; retry shortly, or describe the screenshot yourself and pass source.type "layout" with the image', 'vision_rate_limited');
      if (err instanceof Anthropic.BadRequestError) throw new ToolError(`vision request rejected: ${err.message}`, 'vision_bad_request');
      if (err instanceof Anthropic.APIError) throw new ToolError(`vision provider error ${err.status}: ${err.message}`, 'vision_error');
      throw err;
    }
  };
}
