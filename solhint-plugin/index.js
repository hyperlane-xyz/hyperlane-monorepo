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

class NoMsgValueInternal {
  constructor(reporter, config) {
    this.ruleId = 'no-msg-value-internal';

    this.reporter = reporter;
    this.config = config;
  }

  FunctionDefinition(ctx) {
    if (ctx.visibility === 'internal') {
      const hasMsgValue = ctx.body.statements.some((statement) =>
        JSON.stringify(statement).includes('msg.value'),
      );
      if (hasMsgValue) {
        this.reporter.error(
          ctx,
          this.ruleId,
          'Functions cannot have msg.value if they are internal (only public/external payable)',
        );
      }
    }
  }
}

module.exports = [NoVirtualOverrideAllowed, NoMsgValueInternal];
