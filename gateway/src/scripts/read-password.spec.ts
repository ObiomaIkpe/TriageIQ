import { PassThrough, Writable } from 'node:stream';
import { readPassword, type InputStream } from './read-password.js';

function sink() {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { out, text: () => chunks.join('') };
}

function fakeTerminal() {
  const input = new PassThrough() as unknown as InputStream & PassThrough;
  input.isTTY = true;
  const raw: boolean[] = [];
  input.setRawMode = (mode: boolean) => void raw.push(mode);
  return { input, raw };
}

describe('readPassword on a terminal', () => {
  it('prints the prompt, reads keys without echo, and ends on Enter', async () => {
    const { input, raw } = fakeTerminal();
    const { out, text } = sink();
    const promise = readPassword('Password: ', input, out);
    for (const key of 'hunter2 is bad') input.write(key);
    input.write('\r');

    expect(await promise).toBe('hunter2 is bad');
    // Only the prompt and the final newline were written: typed characters were never echoed.
    expect(text()).toBe('Password: \n');
    expect(text()).not.toContain('hunter');
    expect(raw).toEqual([true, false]); // raw mode on while typing, restored after
  });

  it('Backspace removes the last character', async () => {
    const { input } = fakeTerminal();
    const { out } = sink();
    const promise = readPassword('> ', input, out);
    input.write('abcX\u007f\u007fde'); // a b c X, two backspaces, d e
    input.write('\n');
    expect(await promise).toBe('abde');
  });

  it('Backspace on an emoji removes the whole character', async () => {
    const { input } = fakeTerminal();
    const { out } = sink();
    const promise = readPassword('> ', input, out);
    input.write('a😀\u007f');
    input.write('\r');
    expect(await promise).toBe('a');
  });

  it('Ctrl-C cancels and restores the terminal', async () => {
    const { input, raw } = fakeTerminal();
    const { out } = sink();
    const promise = readPassword('> ', input, out);
    input.write('abc\u0003');
    await expect(promise).rejects.toThrow('cancelled');
    expect(raw).toEqual([true, false]);
  });

  it('keys can arrive in one chunk or many', async () => {
    const { input } = fakeTerminal();
    const { out } = sink();
    const promise = readPassword('> ', input, out);
    input.write('one two ');
    input.write('three\r');
    expect(await promise).toBe('one two three');
  });
});

describe('readPassword when input is not a terminal (a pipe or a test)', () => {
  it('reads one line and prints nothing, not even a prompt', async () => {
    const input = new PassThrough() as unknown as InputStream & PassThrough;
    const { out, text } = sink();
    const promise = readPassword('Password: ', input, out);
    input.write('the first line\nthe second line\n');
    expect(await promise).toBe('the first line');
    expect(text()).toBe('');
  });

  it('strips a Windows line ending', async () => {
    const input = new PassThrough() as unknown as InputStream & PassThrough;
    const promise = readPassword('> ', input, sink().out);
    input.write('secret phrase here\r\n');
    expect(await promise).toBe('secret phrase here');
  });

  it('takes the text when the input ends without a newline', async () => {
    const input = new PassThrough() as unknown as InputStream & PassThrough;
    const promise = readPassword('> ', input, sink().out);
    input.end('no newline at the end');
    expect(await promise).toBe('no newline at the end');
  });

  it('an empty input gives an empty string (the password rules reject it later)', async () => {
    const input = new PassThrough() as unknown as InputStream & PassThrough;
    const promise = readPassword('> ', input, sink().out);
    input.end();
    expect(await promise).toBe('');
  });

  it('keeps spaces inside and around the password', async () => {
    const input = new PassThrough() as unknown as InputStream & PassThrough;
    const promise = readPassword('> ', input, sink().out);
    input.write('  spaced out  \n');
    expect(await promise).toBe('  spaced out  ');
  });
});
