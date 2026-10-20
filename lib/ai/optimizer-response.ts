/** A leading explicit no-action decision stays empty even if the model adds an explanation. */
export function parseOptimizerResponse(text: string): unknown {
  const json = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1] ?? text.trim();
  if (/^\{\s*"actions"\s*:\s*\[\s*\]\s*\}\s*(?:\n|$)/.test(json)) return { actions: [] };
  return JSON.parse(json);
}
