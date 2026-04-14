import 'server-only';
import { headers } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import type { ZodError, ZodType } from 'zod';
import { auth } from './auth';

type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

type RouteOptions<Q, P> = {
    /** Require a Better Auth session. Default true. Set false for public routes. */
    auth?: boolean;
    /** Zod schema for `URLSearchParams` → typed query object. */
    query?: ZodType<Q>;
    /** Zod schema for the awaited dynamic route params (e.g. `{ slug: string }`). */
    params?: ZodType<P>;
};

type RouteContext<Q, P> = {
    req: NextRequest;
    query: Q;
    params: P;
    session: Session | null;
};

type Handler<Q, P> = (ctx: RouteContext<Q, P>) => Promise<NextResponse> | NextResponse;

type NextRouteHandler = (
    req: NextRequest,
    nextCtx: { params: Promise<Record<string, string | string[]>> },
) => Promise<NextResponse>;

/** Structured error response — keeps shapes consistent across routes. */
export function jsonError(message: string, status: number, details?: unknown) {
    const body: Record<string, unknown> = { error: message };
    if (details !== undefined) body.details = details;
    return NextResponse.json(body, { status });
}

/**
 * Wrap a route handler with auth, validation, and error handling. Call sites stay
 * free of boilerplate: the handler only expresses business logic, returning a
 * `NextResponse`. Any thrown error is caught and serialized by `handleError`.
 *
 * Overloads let the call site omit the options object for the common case.
 *
 *     export const GET = route(() => NextResponse.json(status()));
 *     export const GET = route({ query: searchQuerySchema }, ({ query }) => ...);
 *     export const GET = route({ params: conceptParamsSchema }, ({ params }) => ...);
 */
export function route(handler: Handler<undefined, undefined>): NextRouteHandler;
export function route<Q, P>(options: RouteOptions<Q, P>, handler: Handler<Q, P>): NextRouteHandler;
export function route<Q, P>(
    optionsOrHandler: RouteOptions<Q, P> | Handler<undefined, undefined>,
    maybeHandler?: Handler<Q, P>,
): NextRouteHandler {
    const options: RouteOptions<Q, P> =
        typeof optionsOrHandler === 'function' ? {} : optionsOrHandler;
    const handler = (
        typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler
    ) as Handler<Q, P>;
    const authRequired = options.auth ?? true;

    return async (req, nextCtx) => {
        try {
            let session: Session | null = null;
            if (authRequired) {
                const result = await requireSession();
                if (result.response) return result.response;
                session = result.session;
            }

            const query = options.query
                ? parseOrFail(Object.fromEntries(req.nextUrl.searchParams.entries()), options.query)
                : (undefined as Q);
            if (isFailure(query)) return query.response;

            const params = options.params
                ? parseOrFail(await nextCtx.params, options.params)
                : (undefined as P);
            if (isFailure(params)) return params.response;

            return await handler({
                req,
                query: query as Q,
                params: params as P,
                session,
            });
        } catch (err) {
            return handleError(err);
        }
    };
}

async function requireSession(): Promise<
    { session: Session; response: null } | { session: null; response: NextResponse }
> {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return { session: null, response: jsonError('Unauthorized', 401) };
    return { session, response: null };
}

type Failure = { __failure: true; response: NextResponse };

function parseOrFail<T>(input: unknown, schema: ZodType<T>): T | Failure {
    const result = schema.safeParse(input);
    if (!result.success) {
        return {
            __failure: true,
            response: jsonError('Invalid request', 400, formatIssues(result.error)),
        };
    }
    return result.data;
}

function isFailure(value: unknown): value is Failure {
    return typeof value === 'object' && value !== null && (value as Failure).__failure === true;
}

function formatIssues(error: ZodError) {
    return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function handleError(err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return jsonError(message, 500);
}
