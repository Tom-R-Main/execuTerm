import { execSync } from 'node:child_process';

import { deleteAuthToken, getAuthFilePath, writeAuthToken } from './config.js';
import { ExfClient } from './exfClient.js';
import type { DaemonAuthState } from './types.js';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface DeviceResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
}

interface ErrorResponse {
  error: string;
  error_description?: string;
}

interface AuthCoordinatorOptions {
  apiUrl: string;
  appManaged: boolean;
  onAuthenticated: (client: ExfClient) => Promise<void> | void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      execSync(`open ${JSON.stringify(url)}`, { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execSync(`start "" ${JSON.stringify(url)}`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: 'ignore' });
    }
  } catch {
    // Browser open failed — caller still gets the URL in state/output.
  }
}

export class AuthCoordinator {
  private readonly apiUrl: string;
  private readonly appManaged: boolean;
  private readonly onAuthenticated: AuthCoordinatorOptions['onAuthenticated'];
  private state: DaemonAuthState = {
    status: 'unauthenticated',
    message: 'Not authenticated',
  };
  private pollPromise: Promise<ExfClient | null> | null = null;

  constructor(options: AuthCoordinatorOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.appManaged = options.appManaged;
    this.onAuthenticated = options.onAuthenticated;
  }

  getState(): DaemonAuthState {
    return { ...this.state };
  }

  async initialize(existingToken: string | null): Promise<ExfClient | null> {
    if (existingToken) {
      const client = new ExfClient({ apiUrl: this.apiUrl, pat: existingToken });
      const validation = await client.listProjects();

      if (validation.statusCode >= 200 && validation.statusCode < 300) {
        this.state = { status: 'authenticated' };
        return client;
      }

      if (validation.statusCode === 401 || validation.statusCode === 403) {
        deleteAuthToken();
        this.state = {
          status: 'unauthenticated',
          message: 'Stored ExecuFunction token is invalid. Starting device login.',
        };
      } else {
        this.state = {
          status: 'authenticated',
          message:
            validation.statusCode === 0
              ? 'Using stored ExecuFunction token. API validation is temporarily unavailable.'
              : undefined,
        };
        return client;
      }
    }

    if (this.appManaged) {
      void this.startDeviceFlow();
      return null;
    }

    return this.startDeviceFlow();
  }

  private startDeviceFlow(): Promise<ExfClient | null> {
    if (this.pollPromise) {
      return this.pollPromise;
    }

    this.pollPromise = this.runDeviceFlow().finally(() => {
      this.pollPromise = null;
    });

    return this.pollPromise;
  }

  private async runDeviceFlow(): Promise<ExfClient | null> {
    const deviceRes = await fetch(`${this.apiUrl}/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!deviceRes.ok) {
      this.state = {
        status: 'error',
        message: `Failed to start device login (HTTP ${deviceRes.status}).`,
      };
      return null;
    }

    const device = (await deviceRes.json()) as DeviceResponse;
    this.state = {
      status: 'device_flow',
      message: this.appManaged
        ? 'Authorize execuTerm with ExecuFunction to enable tasks, calendar, and agent sync.'
        : 'Authorize this daemon with ExecuFunction.',
      verificationUri: device.verification_uri,
      verificationUriComplete: device.verification_uri_complete,
      userCode: device.user_code,
      expiresAt: new Date(Date.now() + device.expires_in * 1000).toISOString(),
    };

    if (this.appManaged) {
      console.log(
        `Device login pending. Open ${device.verification_uri_complete} and enter code ${device.user_code}`
      );
    } else {
      console.log('');
      console.log(`  Your verification code: ${device.user_code}`);
      console.log('');
      console.log('  Opening browser...');
      openBrowser(device.verification_uri_complete);
      console.log(`  If the browser did not open, visit: ${device.verification_uri_complete}`);
      console.log('');
      console.log('  Waiting for authorization...');
    }

    let interval = device.interval * 1000;
    const deadline = Date.now() + device.expires_in * 1000;

    while (Date.now() < deadline) {
      await sleep(interval);

      const tokenRes = await fetch(`${this.apiUrl}/auth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_code: device.device_code,
          grant_type: GRANT_TYPE,
        }),
      });

      let body = '';
      try {
        body = await tokenRes.text();
      } catch {
        continue;
      }

      let parsed: TokenResponse | ErrorResponse | undefined;
      try {
        parsed = JSON.parse(body) as TokenResponse | ErrorResponse;
      } catch {
        this.state = {
          status: 'error',
          message: `Device login failed: non-JSON response from ${this.apiUrl}`,
        };
        return null;
      }

      if (tokenRes.ok && parsed && 'access_token' in parsed) {
        writeAuthToken(parsed.access_token);
        const client = new ExfClient({ apiUrl: this.apiUrl, pat: parsed.access_token });
        this.state = {
          status: 'authenticated',
          message: `Logged in. Token stored in ${getAuthFilePath()}`,
        };
        await this.onAuthenticated(client);
        console.log(`Logged in successfully. Token stored in ${getAuthFilePath()}`);
        return client;
      }

      const errorData = parsed as ErrorResponse | undefined;

      switch (errorData?.error) {
        case 'authorization_pending':
          break;
        case 'slow_down':
          interval += 5000;
          break;
        case 'expired_token':
          this.state = {
            status: 'error',
            message: 'Device login session expired. Restart login to continue.',
          };
          return null;
        case 'access_denied':
          this.state = {
            status: 'error',
            message: 'Device login was denied.',
          };
          return null;
        default:
          this.state = {
            status: 'error',
            message: `Unexpected device login error: ${errorData?.error ?? `HTTP ${tokenRes.status}`}`,
          };
          return null;
      }
    }

    this.state = {
      status: 'error',
      message: 'Device login session expired. Restart login to continue.',
    };
    return null;
  }
}
