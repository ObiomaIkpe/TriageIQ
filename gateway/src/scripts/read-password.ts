import type { Readable, Writable } from 'node:stream';

/** A readable stream that may be a terminal. */
export interface InputStream extends Readable {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

/**
 * Reads one password.
 *  - On a terminal: prints the prompt, then reads keys WITHOUT echo (Backspace works; Enter ends;
 *    Ctrl-C cancels). Nothing typed is ever written to the output.
 *  - Not on a terminal (a pipe or a test): reads one line from the input and prints nothing.
 * The password is never an argument, so it cannot end up in shell history.
 */
export function readPassword(prompt: string, input: InputStream, output: Writable): Promise<string> {
  return input.isTTY ? readHidden(prompt, input, output) : readLine(input);
}

function readHidden(prompt: string, input: InputStream, output: Writable): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    input.setRawMode?.(true);
    input.resume();
    let typed = '';
    const finish = (action: () => void) => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      action();
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') return finish(() => resolve(typed));
        if (char === CTRL_C || char === CTRL_D) return finish(() => reject(new Error('cancelled')));
        if (char === '\u007f' || char === '\b') typed = Array.from(typed).slice(0, -1).join('');
        else typed += char;
      }
    };
    input.on('data', onData);
  });
}

function readLine(input: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const done = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
    };
    const onData = (chunk: Buffer | string) => {
      text += String(chunk);
      const newline = text.indexOf('\n');
      if (newline !== -1) {
        done();
        input.pause();
        resolve(text.slice(0, newline).replace(/\r$/, ''));
      }
    };
    const onEnd = () => {
      done();
      resolve(text.replace(/\r$/, ''));
    };
    const onError = (error: Error) => {
      done();
      reject(error);
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}
