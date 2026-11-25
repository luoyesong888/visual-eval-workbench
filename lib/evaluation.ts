import type { ModelSlot } from "./provider-config.ts";
import type { ScoreDimension } from "./benchmarks.ts";

export type Scores = Partial<Record<ScoreDimension, number>>;

export interface GenerationResult {
  slotId: string;
  provider: string;
  modelId: string;
  image?: string;
  mediaType?: string;
  elapsed?: number;
  error?: string;
  scores: Scores;
  winner?: boolean;
  /**
   * Objective metrics from the local Python scorer (webapp/score_server.py):
   * pyiqa musiq-spaq / brisque / clipscore for images, VBench dimensions for
   * video. Kept separate from `scores`, which holds the human 1-5 ratings - the
   * two use different scales and must never be averaged together.
   */
  objective?: Record<string, number>;
  objectiveLabels?: Record<string, string>;
  objectiveLower?: Record<string, boolean>;
  scoring?: boolean;
  scoreError?: string;
}

export interface EvaluationSession {
  id: string;
  createdAt: string;
  title: string;
  prompt: string;
  benchmarkId?: string;
  slots: Array<Omit<ModelSlot, "apiKey">>;
  results: GenerationResult[];
}

export const averageScore = (scores: Scores) => {
  const values = Object.values(scores).filter(
    (value): value is number => typeof value === "number",
  );
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
};
