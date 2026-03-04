#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const verifyCounters = require('./verify/check-counters');

const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');
const ARTILLERY_DIR = path.join(__dirname, 'artillery');
const ARTILLERY_BIN = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', '.bin', 'artillery.cmd')
    : path.join(ROOT, 'node_modules', '.bin', 'artillery');

const TARGET = process.env.LOAD_TEST_BASE_URL || 'http://localhost:8080';
const DEFAULT_CAMPAIGN = process.env.LOAD_TEST_CAMPAIGN_ID || '005EZsfHkpI';

const SCENARIOS = [
    {
        name: 'baseline',
        file: path.join(ARTILLERY_DIR, 'baseline.yml'),
        thresholds: { p95: 500, errorRate: 0.01 }
    },
    {
        name: 'stress',
        file: path.join(ARTILLERY_DIR, 'stress.yml'),
        thresholds: { errorRate: 0.01 }
    },
    {
        name: 'spike',
        file: path.join(ARTILLERY_DIR, 'spike.yml'),
        thresholds: { errorRate: 0.02, p99: 1200 }
    }
];

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sumValues(obj = {}) {
    return Object.values(obj).reduce((acc, value) => acc + (typeof value === 'number' ? value : 0), 0);
}

function extractMetrics(resultPath) {
    const payload = readJson(resultPath);
    const aggregate = payload.aggregate || payload;
    const codes = aggregate.codes || {};
    const errorsFromAggregate = sumValues(aggregate.errors);
    const successCodes = ['200', '201', '202', '204'];
    let successCount = 0;
    let errorCount = 0;

    Object.entries(codes).forEach(([code, count]) => {
        if (successCodes.includes(code)) {
            successCount += count;
        } else {
            errorCount += count;
        }
    });

    const latencyStats = aggregate.latency || aggregate.http?.request_duration || {};
    const latency = {
        p50: latencyStats.median ?? latencyStats.p50 ?? null,
        p95: latencyStats.p95 ?? latencyStats['95th'] ?? null,
        p99: latencyStats.p99 ?? latencyStats['99th'] ?? null
    };

    const totalRequests = (aggregate.requestsCompleted ?? aggregate.counters?.['http.requests'])
        ?? (successCount + errorCount + errorsFromAggregate);
    const totalErrors = errorCount + errorsFromAggregate;
    const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;

    return {
        totalRequests,
        successCount,
        errorCount: totalErrors,
        errorRate,
        latency
    };
}

function evaluateScenario(scenario, metrics) {
    const issues = [];
    if (scenario.thresholds.p95 && metrics.latency.p95 !== null && metrics.latency.p95 > scenario.thresholds.p95) {
        issues.push(`p95 ${metrics.latency.p95.toFixed(2)}ms > ${scenario.thresholds.p95}ms`);
    }
    if (scenario.thresholds.p99 && metrics.latency.p99 !== null && metrics.latency.p99 > scenario.thresholds.p99) {
        issues.push(`p99 ${metrics.latency.p99.toFixed(2)}ms > ${scenario.thresholds.p99}ms`);
    }
    if (typeof scenario.thresholds.errorRate === 'number' && metrics.errorRate > scenario.thresholds.errorRate) {
        issues.push(`error rate ${(metrics.errorRate * 100).toFixed(2)}% > ${(scenario.thresholds.errorRate * 100).toFixed(2)}%`);
    }
    return { pass: issues.length === 0, issues };
}

function runArtilleryScenario(scenario, env) {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(RESULTS_DIR, `${scenario.name}.json`);
        const args = ['run', '-t', TARGET, '--output', outputPath, scenario.file];
        const command = fs.existsSync(ARTILLERY_BIN) ? ARTILLERY_BIN : 'artillery';
        const child = spawn(command, args, { cwd: ROOT, env, stdio: 'inherit' });
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Artillery scenario ${scenario.name} failed with code ${code}`));
                return;
            }
            resolve({ outputPath });
        });
    });
}

async function main() {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const env = { ...process.env };
    if (!env.USE_MOCK_TWILIO) {
        env.USE_MOCK_TWILIO = 'true';
    }
    if (!env.LOAD_TEST_CAMPAIGN_ID) {
        env.LOAD_TEST_CAMPAIGN_ID = DEFAULT_CAMPAIGN;
    }

    const scenarioReports = [];
    for (const scenario of SCENARIOS) {
        console.log(`\n[load-tests] Running scenario: ${scenario.name}`);
        const { outputPath } = await runArtilleryScenario(scenario, env);
        const metrics = extractMetrics(outputPath);
        const evaluation = evaluateScenario(scenario, metrics);
        scenarioReports.push({
            name: scenario.name,
            metrics,
            pass: evaluation.pass,
            issues: evaluation.issues,
            reportPath: outputPath
        });
    }

    const dataIntegrity = verifyCounters([process.env.LOAD_TEST_CAMPAIGN_ID || DEFAULT_CAMPAIGN]);
    const overallReady = scenarioReports.every(report => report.pass) && dataIntegrity.ok;
    const summary = {
        generatedAt: new Date().toISOString(),
        target: TARGET,
        campaignId: process.env.LOAD_TEST_CAMPAIGN_ID || DEFAULT_CAMPAIGN,
        scenarios: scenarioReports,
        dataIntegrity,
        overallReady
    };

    const summaryPath = path.join(RESULTS_DIR, 'report.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    console.log('\n================ Load Test Summary ================');
    scenarioReports.forEach(report => {
        const status = report.pass ? 'PASS' : 'FAIL';
        console.log(`${status} :: ${report.name} — p95: ${report.metrics.latency.p95 ?? 'n/a'}ms, error rate: ${(report.metrics.errorRate * 100).toFixed(2)}%`);
        if (report.issues.length) {
            report.issues.forEach(issue => console.log(`  - ${issue}`));
        }
    });
    console.log(`Data integrity: ${dataIntegrity.ok ? 'PASS' : 'FAIL'}`);
    console.log(`Overall readiness: ${overallReady ? 'READY' : 'NOT READY'}`);
    console.log(`Detailed report: ${summaryPath}`);

    if (!overallReady) {
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error('[load-tests] Run failed:', error.message);
    process.exit(1);
});
