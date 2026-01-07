import { render } from 'ink';
import { App } from './cli/app';
import { project } from './project';
import process from 'node:process';
// import dotenv from 'dotenv';

// dotenv.config();

// Simple CLI entry point
const main = () => {
    // Parse args if needed to set project root
    const args = process.argv.slice(2);
    if (args.length > 0) {
        try {
            project.rootDir = args[0];
        } catch (e: any) {
            console.error(e.message);
            process.exit(1);
        }
    }

    render(<App />);
};

main();
