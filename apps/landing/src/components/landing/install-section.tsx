import { INSTALL_CMDS } from '@lumen/brand';
import { InstallBox } from './copy-button';

const STEPS = [
    ['STEP 01', 'Initialize', 'lumen init'],
    ['STEP 02', 'Ingest something', 'lumen add https://...'],
    ['STEP 03', 'Compile the graph', 'lumen compile'],
    ['STEP 04', 'Wire your agent', INSTALL_CMDS.installClaude],
] as const;

export function InstallSection() {
    return (
        <section id="install" className="final">
            <h2>Compile your reading.</h2>
            <p>
                One SQLite file. Zero servers. Works offline. Wires into your agent in one command.
            </p>

            <InstallBox cmd={INSTALL_CMDS.installAndInit} />

            <div className="steps">
                {STEPS.map(([num, title, cmd]) => (
                    <div className="s" key={num}>
                        <div className="n">{num}</div>
                        <div className="t">{title}</div>
                        <code>{cmd}</code>
                    </div>
                ))}
            </div>
        </section>
    );
}
