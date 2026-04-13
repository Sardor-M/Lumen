export default function DashboardPage() {
    return (
        <div>
            <h1 className="mb-6 text-3xl font-bold">Overview</h1>
            <p className="mb-8 text-neutral-600 dark:text-neutral-400">
                Your knowledge graph at a glance.
            </p>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Stat label="Sources" value="—" />
                <Stat label="Chunks" value="—" />
                <Stat label="Concepts" value="—" />
                <Stat label="Edges" value="—" />
            </div>

            <p className="mt-8 text-sm text-neutral-500 dark:text-neutral-500">
                Stats will be wired to the Lumen engine once the CLI is linked. For now, use the{' '}
                <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-900">
                    lumen status
                </code>{' '}
                command in your terminal.
            </p>
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-xs tracking-wide text-neutral-500 uppercase dark:text-neutral-500">
                {label}
            </p>
            <p className="mt-1 text-2xl font-semibold">{value}</p>
        </div>
    );
}
