/** Public failure evidence attached to the activity that observed it.
 * Consumers display message directly; code is a label for optional filtering,
 * never a key consumers must decode into text. Producers select safe
 * fields explicitly instead of forwarding provider errors or response bodies.
 */
export interface DiagnosticError {
  code: string;
  message: string;
  source: string;
  details?: Record<string, unknown>;
  causes?: DiagnosticError[];
}
