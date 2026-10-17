import { Socket } from 'net';

/**
 * Sends raw bytes to a network receipt printer (the usual "RAW / JetDirect"
 * port 9100). Resolves once the printer accepted every byte and the
 * connection closed; rejects on refusal or timeout so the till can say the
 * receipt did not print.
 */
export function sendRaw(host: string, port: number, data: Uint8Array, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      s.destroy();
      if (err) reject(err);
      else resolve();
    };
    s.setTimeout(timeoutMs, () => finish(new Error(`Printer ${host}:${port} did not respond`)));
    s.once('error', (e) => finish(new Error(`Printer ${host}:${port}: ${e.message}`)));
    s.connect(port, host, () => {
      s.end(Buffer.from(data), () => finish());
    });
  });
}
