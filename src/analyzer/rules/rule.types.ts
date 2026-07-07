export type RuleCategory =
  | 'file' | 'component' | 'react' | 'hooks' | 'performance'
  | 'nextjs' | 'typescript' | 'state' | 'api' | 'architecture'
  | 'dependency' | 'code-smell';

export type RuleSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface RuleMetric {
  actual: number;
  threshold: number;
  unit: 'lines' | 'props' | 'imports' | 'hooks' | 'depth' | 'count' | 'percent';
}

export interface RuleResult {
  id: string;
  category: RuleCategory;
  severity: RuleSeverity;
  title: string;
  description: string;
  file: string;
  line?: number;
  column?: number;
  metric?: RuleMetric;
  recommendation: string;
}

export function finding(base: Omit<RuleResult, 'file'>, file: string): RuleResult {
  return { ...base, file };
}