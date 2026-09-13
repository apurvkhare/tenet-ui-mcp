// Perception (DESIGN.md §2 "Perception", §8 "Vision without sampling"): the only model call the
// server makes. One fixed template, design content in the user turn only, output constrained to
// the layout schema in the catalog's vocabulary. Skipped entirely when the host supplies a layout.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ToolError } from '../tools/context.js';
import { ROLE_HINTS, VisionLayoutSchema, type Layout } from './layout.js';

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

const SYSTEM = `You analyse a screenshot of a user interface and describe it as a layout tree for a design-system server.
Return regions from the outside in: the page, then its sections, then every control and text block. Give each region a stable id (r1, r2, …), a role from this list where one fits (${ROLE_HINTS.join(', ')}), a short label, the visible text strings, pixel bounds relative to the image, its parent id (null for roots), and the raw styles you can read off the pixels (hex colours, px sizes, weights). Fill every field; use null when a style is not visible.
In "candidates", propose up to three component ids from the design system that could implement the region, most likely first. Do not invent ids. For plain layout containers with no border or background, propose "stack" or "grid". For a bordered or raised container, propose "card".
In "states", note things like primary, secondary, danger, disabled, selected, error, required, icon-only, sortable, selectable, loading.
Be literal: report what is drawn, not what you think it should be.`;

export function createVision(): VisionFn {
  const client = new Anthropic();
  const model = process.env.VISION_MODEL ?? 'claude-opus-5';
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
      if (!parsed) throw new ToolError('the vision model returned no parseable layout; retry, or pass `layout`', 'vision_unparseable');
      return { layout: parsed, model: response.model, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
    } catch (err) {
      if (err instanceof ToolError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new ToolError('vision is not configured on this server (no model credentials); pass `layout` instead of an image', 'vision_unavailable');
      if (err instanceof Anthropic.RateLimitError) throw new ToolError('vision provider rate-limited; retry shortly or pass `layout`', 'vision_rate_limited');
      if (err instanceof Anthropic.BadRequestError) throw new ToolError(`vision request rejected: ${err.message}`, 'vision_bad_request');
      if (err instanceof Anthropic.APIError) throw new ToolError(`vision provider error ${err.status}: ${err.message}`, 'vision_error');
      throw err;
    }
  };
}
