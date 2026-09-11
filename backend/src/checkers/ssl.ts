import tls from 'node:tls';

export interface SSLCheckResult {
  valid: boolean;
  daysRemaining: number;
  issuer?: string;
  expiryDate?: string;
  error?: string;
}

export function checkSSL(hostname: string, port = 443, timeoutMs = 8000): Promise<SSLCheckResult> {
  return new Promise((resolve) => {
    // Strip protocol or path if accidentally present
    let host = hostname.replace(/^https?:\/\//i, '').split('/')[0];
    if (host.includes(':')) {
      const parts = host.split(':');
      host = parts[0];
      port = parseInt(parts[1], 10) || port;
    }

    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false, // Inspect certificate even if self-signed/expired
        timeout: timeoutMs
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(true);
          socket.end();

          if (!cert || !cert.valid_to) {
            return resolve({
              valid: false,
              daysRemaining: 0,
              error: 'No peer certificate found'
            });
          }

          const expiry = new Date(cert.valid_to);
          const now = new Date();
          const msRemaining = expiry.getTime() - now.getTime();
          const daysRemaining = Math.round(msRemaining / (1000 * 60 * 60 * 24));
          const issuerRaw = typeof cert.issuer === 'object' ? (cert.issuer.O || cert.issuer.CN || 'Unknown') : 'Unknown';
          const issuer = Array.isArray(issuerRaw) ? issuerRaw.join(', ') : issuerRaw;

          resolve({
            valid: daysRemaining > 0,
            daysRemaining,
            issuer,
            expiryDate: expiry.toISOString().split('T')[0]
          });
        } catch (err: any) {
          socket.destroy();
          resolve({
            valid: false,
            daysRemaining: 0,
            error: err.message || 'Failed to inspect certificate'
          });
        }
      }
    );

    socket.on('timeout', () => {
      socket.destroy();
      resolve({
        valid: false,
        daysRemaining: 0,
        error: 'TLS handshake connection timed out'
      });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({
        valid: false,
        daysRemaining: 0,
        error: err.message || 'TLS connection error'
      });
    });
  });
}
