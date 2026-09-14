export interface ChainStep {
  name: string;
  target: string;
  status: 'ok' | 'fail' | 'skipped';
  statusCode?: number;
  latency?: number;
  details?: string;
}

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
  chainDetails?: {
    initialUrl: string;
    finalUrl: string;
    redirected: boolean;
    keywordFound?: boolean;
    keyword?: string;
    ssoUrl?: string;
    steps?: ChainStep[];
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
  http_method?: string | null;
  http_headers?: string | null;
  http_body?: string | null;
  expected_status?: string | null;
  follow_redirects?: number | null;
}
