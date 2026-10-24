// Extrai JSON de respostas de LLM (que às vezes vêm com ```json ... ``` ou texto em volta).

function stripFence(text) {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return block ? block[1].trim() : text.trim();
}

export function extractJSON(text) {
  const content = stripFence(text);
  const obj = content.match(/\{[\s\S]*\}/);
  return JSON.parse(obj ? obj[0] : content);
}

export function extractJSONArray(text) {
  const content = stripFence(text);
  const arr = content.match(/\[[\s\S]*\]/);
  return JSON.parse(arr ? arr[0] : content);
}
