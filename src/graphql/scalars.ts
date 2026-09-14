/**
 * Two scalars that exist to say what a string means (D§8.1).
 *
 * `Date` is a calendar day at the location and carries no time or zone; `DateTime` is an
 * instant in UTC. Keeping them apart in the schema is what stops a client treating a
 * local date as an instant and shifting it by a day.
 */
import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new GraphQLError(`${name} must be a string`);
  return value;
}

export const DateScalar = new GraphQLScalarType<string, string>({
  name: 'Date',
  description: "Calendar date in the location's local timezone, YYYY-MM-DD.",

  serialize(value) {
    const text = asString(value, 'Date');
    if (!LOCAL_DATE.test(text)) throw new GraphQLError(`Date must be YYYY-MM-DD, got "${text}"`);
    return text;
  },

  parseValue(value) {
    const text = asString(value, 'Date');
    if (!LOCAL_DATE.test(text)) throw new GraphQLError(`Date must be YYYY-MM-DD, got "${text}"`);
    return text;
  },

  parseLiteral(node) {
    if (node.kind !== Kind.STRING) throw new GraphQLError('Date must be a string');
    if (!LOCAL_DATE.test(node.value)) {
      throw new GraphQLError(`Date must be YYYY-MM-DD, got "${node.value}"`);
    }
    return node.value;
  },
});

function assertInstant(text: string): string {
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new GraphQLError(`DateTime is not an instant: "${text}"`);
  return parsed.toISOString();
}

export const DateTimeScalar = new GraphQLScalarType<string, string>({
  name: 'DateTime',
  description: 'ISO-8601 instant in UTC.',

  // Everything stored is already an ISO UTC string, but normalising here means the API
  // cannot start emitting a local-time instant because something upstream changed.
  serialize: (value) => assertInstant(asString(value, 'DateTime')),
  parseValue: (value) => assertInstant(asString(value, 'DateTime')),

  parseLiteral(node) {
    if (node.kind !== Kind.STRING) throw new GraphQLError('DateTime must be a string');
    return assertInstant(node.value);
  },
});
