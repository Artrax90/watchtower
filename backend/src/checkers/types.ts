export interface CheckResult {
  status: 'online' | 'down' | 'degraded';
  latency: number;
  statusCode?: number | null;
  error?: string | null;
  ip?: string;
  ssl?: {
    daysRemaining: number;
    issuer?: string;
    expiryDate?: string;
    valid: boolean;
    error?: string;
  };
}

export interface MonitorCheckTarget {
  id: string;
  name: string;
  type: string; // 'http', 'port', 'ping', 'dns'
  target: string;
  port?: number | null;
  timeout: number;
  keyword?: string | null;
  check_ssl?: number;
  ssl_alert_days?: number;
}
