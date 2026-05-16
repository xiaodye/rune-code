import { useState, useEffect } from 'react';
import { Text, Box } from 'ink';
import figlet from 'figlet';
import gradient from 'gradient-string';

export const Banner = () => {
    const [text, setText] = useState('');

    useEffect(() => {
        // 'Cyberlarge' or 'Big' might be good. 'Standard' is safe.
        // Let's try 'Big' for a larger effect like the image.
        figlet.text('RUNE CODE', { font: 'Big' }, (err, data) => {
            if (err) {
                return;
            }
            if (data) {
                // Custom gradient matching the image (Blue -> Purple -> Pink)
                const coolGradient = gradient(['#4FACFE', '#00F2FE', '#f093fb', '#f5576c']);
                setText(coolGradient.multiline(data));
            }
        });
    }, []);

    if (!text) return null;

    return (
        <Box marginBottom={1} height={6}>
            <Text>{text}</Text>
        </Box>
    );
};
