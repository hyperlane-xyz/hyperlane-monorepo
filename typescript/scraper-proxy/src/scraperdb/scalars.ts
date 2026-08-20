import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';

const passThroughScalar = (name: string) =>
  new GraphQLScalarType({
    name,
    parseLiteral(ast) {
      if (
        ast.kind === Kind.STRING ||
        ast.kind === Kind.INT ||
        ast.kind === Kind.FLOAT ||
        ast.kind === Kind.BOOLEAN
      ) {
        return ast.value;
      }
      if (ast.kind === Kind.NULL) return null;
      throw new GraphQLError(`${name} cannot represent literal ${ast.kind}`);
    },
    parseValue(value) {
      return value;
    },
    serialize(value) {
      return value;
    },
  });

export const scalarResolvers = {
  bigint: passThroughScalar('bigint'),
  bytea: passThroughScalar('bytea'),
  interval: passThroughScalar('interval'),
  numeric: passThroughScalar('numeric'),
  timestamp: passThroughScalar('timestamp'),
};
