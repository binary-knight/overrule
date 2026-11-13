// Whether a model ID someone typed is one a provider listed. Shared by the server, which warns when a connection is saved, and
// the browser, which warns while the ID is typed, so both say the same thing. Ollama treats "name" and "name:latest" as one model,
// and Hugging Face's router takes a ":provider" or ":policy" suffix after the Hub name, so both compare without it.
export function sameModel(type, wanted, listed) {
  if (wanted === listed) return true;
  if (type === 'huggingface') return wanted.replace(/:[^/:]+$/, '') === listed;
  if (type === 'compatible') return wanted.replace(/:latest$/, '') === listed.replace(/:latest$/, '');
  return false;
}
export const findModel = (type, wanted, models = []) => models.find(m => sameModel(type, wanted, m.id)) || null;
