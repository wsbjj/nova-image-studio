import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

describe('backend Nacos remote config proxy', () => {
  it('exposes a local fetch endpoint for the settings modal', () => {
    expect(serverSource).toContain('/api/nova/remote-config/nacos/fetch');
  });

  it('fetches JSON config through the Nacos 3.x client OpenAPI', () => {
    expect(serverSource).toContain('/nacos/v3/client/cs/config');
    expect(serverSource).toContain('/nacos/v3/admin/cs/config');
    expect(serverSource).toContain("url.searchParams.set('dataId', config.dataId)");
    expect(serverSource).toContain("url.searchParams.set('groupName', config.groupName)");
    expect(serverSource).toContain("url.searchParams.set('namespaceId', config.namespaceId)");
  });

  it('supports optional Nacos auth login before fetching', () => {
    expect(serverSource).toContain('/nacos/v3/auth/user/login');
    expect(serverSource).toContain('/nacos/v1/auth/login');
    expect(serverSource).toContain("url.searchParams.set('accessToken', accessToken)");
  });

  it('turns anonymous access denied into a clear credential hint', () => {
    expect(serverSource).toContain('请填写 Nacos 用户名和密码后重试');
  });

  it('turns console-only Nacos endpoints into a clear server address hint', () => {
    expect(serverSource).toContain('Nacos OpenAPI 地址不通');
    expect(serverSource).toContain('请填写 Nacos Server 地址');
  });
});
