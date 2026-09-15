/**
 * How much one request is allowed to cost upstream (D-028).
 *
 * Nothing stops a caller aliasing the same root field five hundred times, and each
 * `activityRankings` is a geocode plus two Open-Meteo fetches for a location nobody has
 * asked about before. Depth is not the problem here, the schema is four levels deep and
 * acyclic; breadth is. This is a validation rule rather than a check in the resolver
 * because it should cost nothing and happen before any of them run.
 */
import type { ASTVisitor, SelectionSetNode, ValidationContext, ValidationRule } from 'graphql';
import { GraphQLError, Kind } from 'graphql';

/** Open-Meteo's free tier is around ten thousand calls a day. */
export const MAX_ROOT_FIELDS = 10;

function countRootFields(
  selectionSet: SelectionSetNode,
  context: ValidationContext,
  seen: Set<string>,
): number {
  let total = 0;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      total += 1;
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      total += countRootFields(selection.selectionSet, context, seen);
    } else {
      // Fragments are followed, or the limit would be one spread away from meaningless.
      const name = selection.name.value;
      if (seen.has(name)) continue; // a cycle is someone else's error to report
      seen.add(name);
      const fragment = context.getFragment(name);
      if (fragment) total += countRootFields(fragment.selectionSet, context, seen);
    }
  }

  return total;
}

export function rootFieldLimit(max: number = MAX_ROOT_FIELDS): ValidationRule {
  return (context): ASTVisitor => ({
    OperationDefinition(node) {
      const asked = countRootFields(node.selectionSet, context, new Set());
      if (asked <= max) return;

      context.reportError(
        new GraphQLError(
          `A request may ask for at most ${max} root fields, and this one asks for ${asked}.`,
          { nodes: [node], extensions: { code: 'BAD_USER_INPUT' } },
        ),
      );
    },
  });
}
