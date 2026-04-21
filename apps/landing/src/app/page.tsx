import { Nav } from '@/components/landing/nav';
import { Hero } from '@/components/landing/hero';
import { Problem } from '@/components/landing/problem';
import { Demo } from '@/components/landing/demo';
import { HowItWorks } from '@/components/landing/how-it-works';
import { KnowledgeModel } from '@/components/landing/knowledge-model';
import { AgentWiring } from '@/components/landing/agent-wiring';
import { McpSection } from '@/components/landing/mcp-section';
import { CliSection } from '@/components/landing/cli-section';
import { InstallSection } from '@/components/landing/install-section';
import { Footer } from '@/components/landing/footer';

export default function Page() {
    return (
        <>
            <Nav />
            <Hero />
            <Problem />
            <Demo />
            <HowItWorks />
            <KnowledgeModel />
            <AgentWiring />
            <McpSection />
            <CliSection />
            <InstallSection />
            <Footer />
        </>
    );
}
