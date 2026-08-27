// ABOUTME: Fails the build when resources/list outgrows its byte budget: the vendored skills are
// ABOUTME: static guidance a host fetches in one go, so their listing must stay a small payload.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createSteelMcpServer } from '../../src/core/server.js';
import { testDeps } from '../helpers/fakes.js';

interface BudgetFile {
    resourcesListBytes: number;
}

const budgets = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../tool-budgets.json', import.meta.url)), 'utf8')
) as BudgetFile;

describe('resources/list byte budget', () => {
    it(`stays within ${budgets.resourcesListBytes} bytes`, async () => {
        const server = createSteelMcpServer(testDeps());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'budget', version: '1.0.0' });
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        try {
            const { resources } = await client.listResources();
            const bytes = Buffer.byteLength(JSON.stringify(resources), 'utf8');
            process.stdout.write(
                `  resources/list: ${resources.length} resources, ${bytes} bytes (budget ${budgets.resourcesListBytes})\n`
            );
            expect(bytes).toBeLessThanOrEqual(budgets.resourcesListBytes);
            // A missing key would make the comparison NaN and pass; and the budget must never be
            // raised past 16 KB, the ceiling this feature was sized against.
            expect(budgets.resourcesListBytes).toBeTypeOf('number');
            expect(budgets.resourcesListBytes).toBeLessThanOrEqual(16_000);
        } finally {
            await client.close();
            await server.close();
        }
    });
});
