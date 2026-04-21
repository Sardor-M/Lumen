import { COPYRIGHT, LINKS } from '@lumen/brand';

export function Footer() {
    return (
        <footer>
            <div>{COPYRIGHT}</div>
            <div className="links">
                <a href={LINKS.github}>github</a>
                <a href={LINKS.docs}>docs</a>
                <a href={LINKS.changelog}>changelog</a>
                <a href={LINKS.discord}>discord</a>
                <a href="#top">↑ top</a>
            </div>
        </footer>
    );
}
