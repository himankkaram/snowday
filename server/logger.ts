const debugEnabled = () => process.env.DEBUG_LOG === 'true';
const ts = () => new Date().toISOString().slice(11, 23);

export const log = {
  info: (msg: string, extra?: unknown) => console.log(`${ts()} INFO  ${msg}`, extra ?? ''),
  warn: (msg: string, extra?: unknown) => console.warn(`${ts()} WARN  ${msg}`, extra ?? ''),
  error: (msg: string, extra?: unknown) => console.error(`${ts()} ERROR ${msg}`, extra ?? ''),
  debug: (msg: string, extra?: unknown) => {
    if (debugEnabled()) console.log(`${ts()} DEBUG ${msg}`, extra ?? '');
  },
};
