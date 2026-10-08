/** One JSON object per line, which is what the container log keeps. No caller ever passes a client address. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function jsonLogger(out: NodeJS.WritableStream = process.stdout, err: NodeJS.WritableStream = process.stderr): Logger {
  const write = (stream: NodeJS.WritableStream, level: string, message: string, fields?: Record<string, unknown>): void => {
    stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
  };
  return {
    info: (message, fields) => write(out, 'info', message, fields),
    warn: (message, fields) => write(err, 'warn', message, fields),
    error: (message, fields) => write(err, 'error', message, fields),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
