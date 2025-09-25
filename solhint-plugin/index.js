// https://protofire.github.io/solhint/docs/writing-plugins.html
class NoVirtualOverrideAllowed {
  constructor(reporter, config) {
    this.ruleId = 'no-virtual-override';

    this.reporter = reporter;
    this.config = config;
  }

  FunctionDefinition(ctx) {
    const isVirtual = ctx.isVirtual;
    const hasOverride = ctx.override !== null;

    if (isVirtual && hasOverride) {
      this.reporter.error(
        ctx,
        this.ruleId,
        'Functions cannot be "virtual" and "override" at the same time',
      );
    }
  }
}

module.exports = [NoVirtualOverrideAllowed];
