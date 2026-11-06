import WORDS from './blocked-words.json' with { type: 'json' };

// Masks a short list of offensive words in anything shown in a room.
// Nexconn's server-side profanity filter (server/set-word-filter.mjs) uses the
// same list for chat text; this also covers questions, polls and nicknames.
// Words match at the start of a word ("shitty" yes, "Scunthorpe" no); short ones only whole.
const RE = new RegExp(WORDS.map(w => w.length <= 3 ? `\\b${w}\\b` : `\\b${w}`).join('|'), 'gi');
export const clean = (text: string) => text.replace(RE, m => '•'.repeat(m.length));
