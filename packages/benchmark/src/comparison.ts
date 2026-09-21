import fs from "node:fs";
import path from "node:path";
import { sha256Bytes } from "./hash.js";
import { loadBenchmarkReport } from "./runner.js";
import type { BenchmarkComparisonPair, BenchmarkComparisonReport, BenchmarkReport } from "./types.js";

function mean(values: number[]): number | null { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function rate(values: boolean[]): number | null { return values.length ? values.filter(Boolean).length / values.length : null; }
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}
function winner(baseline: any, candidate: any): BenchmarkComparisonPair["outcome"] {
  if (candidate.score.passed !== baseline.score.passed) return candidate.score.passed ? "candidate_win" : "baseline_win";
  const delta = candidate.score.score - baseline.score.score;
  if (Math.abs(delta) <= 1e-12) return "tie";
  return delta > 0 ? "candidate_win" : "baseline_win";
}
function descriptor(report: BenchmarkReport): { run_id: string; agent_id: string; agent_version?: string } {
  return { run_id: report.run_id, agent_id: report.agent.id, ...(report.agent.version ? { agent_version: report.agent.version } : {}) };
}

export function compareBenchmarkReports(baseline: BenchmarkReport, candidate: BenchmarkReport, bootstrapSamples = 2000): BenchmarkComparisonReport {
  if (baseline.suite.id !== candidate.suite.id || baseline.suite.revision !== candidate.suite.revision || baseline.suite.digest !== candidate.suite.digest) throw new TypeError("Benchmark reports must use the same suite id, revision, and digest.");
  if (baseline.options.seed !== candidate.options.seed) throw new TypeError("Paired benchmark reports must use the same run-level seed.");
  const baselineMap = new Map(baseline.trials.map((trial) => [`${trial.task_id}\0${trial.trial}\0${trial.trial_seed}`, trial]));
  const pairs: BenchmarkComparisonPair[] = [];
  for (const candidateTrial of candidate.trials) {
    const key = `${candidateTrial.task_id}\0${candidateTrial.trial}\0${candidateTrial.trial_seed}`;
    const baselineTrial = baselineMap.get(key);
    if (!baselineTrial || baselineTrial.task_digest !== candidateTrial.task_digest) continue;
    pairs.push({
      task_id: candidateTrial.task_id,
      trial: candidateTrial.trial,
      trial_seed: candidateTrial.trial_seed,
      baseline: { passed: baselineTrial.score.passed, score: baselineTrial.score.score, duration_ms: baselineTrial.duration_ms },
      candidate: { passed: candidateTrial.score.passed, score: candidateTrial.score.score, duration_ms: candidateTrial.duration_ms },
      outcome: winner(baselineTrial, candidateTrial)
    });
  }
  pairs.sort((left, right) => left.task_id.localeCompare(right.task_id) || left.trial - right.trial);
  const values: number[] = pairs.map((pair) => pair.outcome === "candidate_win" ? 1 : pair.outcome === "baseline_win" ? -1 : 0);
  const candidateWins = values.filter((value) => value > 0).length;
  const baselineWins = values.filter((value) => value < 0).length;
  const ties = values.filter((value) => value === 0).length;
  let interval: [number, number] | null = null;
  if (values.length > 0) {
    const seed = Number.parseInt(sha256Bytes(`${baseline.run_id}\0${candidate.run_id}\0${baseline.suite.digest}`).slice(0, 8), 16) >>> 0;
    const random = mulberry32(seed);
    const samples: number[] = [];
    const count = Math.max(200, Math.min(20_000, Math.floor(bootstrapSamples)));
    for (let sample = 0; sample < count; sample += 1) {
      let sum = 0;
      for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)]!;
      samples.push(sum / values.length);
    }
    interval = [percentile(samples, 0.025), percentile(samples, 0.975)];
  }
  const advantage = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const interpretation = values.length === 0
    ? "No comparable paired trials were found. This report provides no comparative evidence."
    : interval && interval[0] > 0
      ? `The candidate showed a positive paired advantage on this exact suite and trial set. The result does not establish a universal advantage outside these tasks, models, prompts, or environments.`
      : interval && interval[1] < 0
        ? `The baseline showed a positive paired advantage on this exact suite and trial set. The result does not establish a universal advantage outside these tasks, models, prompts, or environments.`
        : `The paired result is inconclusive at the reported bootstrap interval. More trials or a broader task suite may be needed; no universal conclusion is warranted.`;
  return {
    schema_version: "1.0",
    kind: "emacs_operator_benchmark_comparison",
    created_at: new Date().toISOString(),
    suite: { id: baseline.suite.id, revision: baseline.suite.revision, digest: baseline.suite.digest },
    baseline: descriptor(baseline),
    candidate: descriptor(candidate),
    pairs,
    summary: {
      paired_trials: pairs.length,
      candidate_wins: candidateWins,
      baseline_wins: baselineWins,
      ties,
      candidate_advantage: advantage,
      bootstrap_95_ci: interval,
      baseline_pass_rate: rate(pairs.map((pair) => pair.baseline.passed)),
      candidate_pass_rate: rate(pairs.map((pair) => pair.candidate.passed)),
      baseline_mean_score: mean(pairs.map((pair) => pair.baseline.score)),
      candidate_mean_score: mean(pairs.map((pair) => pair.candidate.score))
    },
    interpretation
  };
}

export function compareBenchmarkReportFiles(baselineFile: string, candidateFile: string, outputFile?: string): BenchmarkComparisonReport {
  const report = compareBenchmarkReports(loadBenchmarkReport(baselineFile), loadBenchmarkReport(candidateFile));
  if (outputFile) {
    const target = path.resolve(outputFile);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return report;
}
