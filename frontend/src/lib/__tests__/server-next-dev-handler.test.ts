import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

describe('backend Next.js dev request handler', () => {
  it('lets Next.js parse the original request URL in development mode', () => {
    expect(serverSource).toContain('handle(req, res);');
    expect(serverSource).not.toContain("handle(req, res, req.url || '/')");
  });
});
