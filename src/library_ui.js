document.addEventListener('DOMContentLoaded', () => {
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const libraryWrapper = document.getElementById('library-wrapper');
    const THEME_KEY = 'themePreference';

    // Function to apply the saved theme on startup
    const applySavedTheme = async () => {
        const data = await browser.storage.local.get(THEME_KEY);
        if (data[THEME_KEY] === 'dark') {
            libraryWrapper.classList.add('dark');
            themeToggleBtn.textContent = '☀️';
        } else {
            libraryWrapper.classList.remove('dark');
            themeToggleBtn.textContent = '🌙';
        }
    };

    themeToggleBtn.addEventListener('click', () => {
        const isDark = libraryWrapper.classList.toggle('dark');
        browser.storage.local.set({ [THEME_KEY]: isDark ? 'dark' : 'light' });
        themeToggleBtn.textContent = isDark ? '☀️' : '🌙';
    });

    applySavedTheme();

    const filterInput = document.getElementById('filter-prompts');
    filterInput.addEventListener('input', () => {
        const filterText = filterInput.value.toLowerCase();
        const promptItems = libraryWrapper.shadowRoot.querySelectorAll('.prompt-item');
        promptItems.forEach(item => {
            const itemText = item.textContent.toLowerCase();
            if (itemText.includes(filterText)) {
                item.style.display = 'block';
            } else {
                item.style.display = 'none';
            }
        });
    });

    const importType = document.getElementById('import-type');
    const pasteInput = document.getElementById('paste-input');
    const uploadInput = document.getElementById('upload-input');
    const urlInput = document.getElementById('url-input');

    importType.addEventListener('change', () => {
        pasteInput.style.display = 'none';
        uploadInput.style.display = 'none';
        urlInput.style.display = 'none';

        switch (importType.value) {
            case 'paste':
                pasteInput.style.display = 'block';
                break;
            case 'upload':
                uploadInput.style.display = 'block';
                break;
            case 'url':
                urlInput.style.display = 'block';
                break;
        }
    });

    // Trigger the change event to set the initial state
    importType.dispatchEvent(new Event('change'));

    const importBtn = document.getElementById('import-prompt-btn');
    importBtn.addEventListener('click', async () => {
        const type = importType.value;
        let content = '';

        try {
            switch (type) {
                case 'paste':
                    content = pasteInput.value;
                    break;
                case 'upload':
                    if (uploadInput.files.length > 0) {
                        content = await uploadInput.files[0].text();
                    }
                    break;
                case 'url':
                    content = urlInput.value;
                    break;
            }

            if (!content.trim()) {
                alert('No content to import.');
                return;
            }

            browser.runtime.sendMessage({
                action: 'importPrompt',
                type: type,
                content: content
            }).then(response => {
                if (response.status === 'ok') {
                    alert('Prompt imported successfully!');
                } else {
                    alert(`Error importing prompt: ${response.error}`);
                }
            });

        } catch (error) {
            alert(`An error occurred: ${error.message}`);
            console.error(error);
        }
    });
});
