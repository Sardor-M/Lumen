import { SITE_NAME, VERSION } from '@lumen/brand';

const NAV_LINKS = [
    ['#problem', 'problem'],
    ['#demo', 'demo'],
    ['#how', 'how it works'],
    ['#graph', 'graph'],
    ['#agent', 'agent'],
    ['#mcp', 'mcp'],
    ['#cli', 'cli'],
] as const;

export function Nav() {
    return (
        <nav className="top">
            <div className="wrap row">
                <div className="brand">
                    <div className="mark" />
                    {SITE_NAME.toLowerCase()}
                    <small>{VERSION}</small>
                </div>
                <ul>
                    {NAV_LINKS.map(([href, label]) => (
                        <li key={href}>
                            <a href={href}>{label}</a>
                        </li>
                    ))}
                </ul>
                <div className="cta">
                    <span className="kbd">⌘</span>
                    <span className="kbd">K</span>
                    <a className="btn sm ghost" href="#">
                        docs
                    </a>
                    <a className="btn sm" href="#install">
                        install <span className="arr"></span>
                    </a>
                </div>
            </div>
        </nav>
    );
}
