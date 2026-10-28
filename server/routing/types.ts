// server/routing/types.ts

export interface ModelCost {
  input: number;
  output: number;
}

export interface RoutingRule {
  primary: string;
  fallbacks: string[];
  qualityScores?: Record<string, number>;
}

export interface Budget {
  maxCost: number;
}

export interface ModelAssignment {
  stepId?: string;
  primary: {
    provider: string;
    model: string;
    estimatedCost: number;
  };
  fallbacks: string[];
  reasoning?: string;
}
