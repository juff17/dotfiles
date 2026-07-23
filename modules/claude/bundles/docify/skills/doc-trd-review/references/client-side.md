# Reviewing client-side work

_Load when the TRD touches the frontend, micro-frontends, or feature flags._

# Frontend

## Component & state architecture

## Data fetching, caching & UI states

## Rendering strategy

## Accessibility

## Additional concerns

- Performance (bundle size, render cost, Core Web Vitals)
- Design-system consistency
- Error boundaries

# Micro-frontends

## Integration model

## Shared-dependency version skew

## Independent deploy vs consistent UX

## Cross-MFE communication & routing

## Additional concerns

- Shared auth & session
- Blast radius of the shell

# Feature flags

## Flag lifecycle & cleanup

## Sticky bucketing & consistency

## Gradual rollout & kill switch

## Additional concerns

- Flag taxonomy
- Combinatorial testing of states
- Fallback when the flag service is down
