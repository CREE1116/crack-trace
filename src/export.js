/* Parser for the plain-text Crack chat export; never sends or stores its input. */
const CrackChatExport = (() => {
  function parse(text) {
    const sections = String(text).split(/^─{8,}\s*$/m);
    const messages = [];
    for (const section of sections) {
      const match = section.match(/^\[(AI|유저)\]\s*\n([\s\S]*)$/m);
      if (!match) continue;
      const body = match[2].trim();
      if (!body) continue;
      messages.push({ id: `export-${String(messages.length + 1).padStart(4, '0')}`, role: match[1] === 'AI' ? 'assistant' : 'user', status: 'end', text: body });
    }
    return messages;
  }
  return { parse };
})();
