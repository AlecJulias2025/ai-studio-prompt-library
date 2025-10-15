document.addEventListener('DOMContentLoaded', () => {
    const procedureEditor = document.getElementById('procedure-editor');
    const saveProcedureBtn = document.getElementById('save-procedure-btn');
    const sourcesEditor = document.getElementById('sources-editor');
    const saveSourcesBtn = document.getElementById('save-sources-btn');
    const launchUpdaterBtn = document.getElementById('launch-updater-btn');
    const exportBtn = document.getElementById('export-btn');
    const importFile = document.getElementById('import-file');

    const PROCEDURE_KEY = 'procedureConfiguration';
    const CACHE_KEY = 'promptLibraryCache';
    const PROMPT_SOURCES_KEY = 'promptSources';

    // --- Load existing settings ---
    
    // Load procedure.json
    browser.storage.local.get(PROCEDURE_KEY)
        .then(data => {
            if (data[PROCEDURE_KEY]) {
                procedureEditor.value = JSON.stringify(data[PROCEDURE_KEY], null, 2);
            }
        });
        
    // Load prompt sources from storage
    browser.storage.local.get(PROMPT_SOURCES_KEY)
        .then(data => {
            if (data[PROMPT_SOURCES_KEY]) {
                sourcesEditor.value = data[PROMPT_SOURCES_KEY].join('\n');
            }
        });


    // --- Save functionality ---

    saveProcedureBtn.addEventListener('click', () => {
        try {
            const procedure = JSON.parse(procedureEditor.value);
            browser.storage.local.set({ [PROCEDURE_KEY]: procedure })
                .then(() => alert('Procedure configuration saved!'));
        } catch (error) {
            alert('Error: Invalid JSON in procedure configuration.');
            console.error(error);
        }
    });

    saveSourcesBtn.addEventListener('click', () => {
        const sources = sourcesEditor.value.split('\n').map(s => s.trim()).filter(Boolean);
        browser.storage.local.set({ [PROMPT_SOURCES_KEY]: sources })
            .then(() => {
                // Now, send a message to the background script to trigger a refresh.
                return browser.runtime.sendMessage({ action: 'refreshPrompts' });
            })
            .then(response => {
                if (response && response.status === 'ok') {
                    alert('Prompt sources saved and refreshed successfully!');
                } else {
                    alert('Prompt sources saved, but an error occurred during refresh. Check the background console.');
                }
            })
            .catch(error => {
                alert(`An error occurred: ${error.message}`);
                console.error(error);
            });
    });

    // --- Updater Mode ---
    
    launchUpdaterBtn.addEventListener('click', async () => {
       try {
            const tabs = await browser.tabs.query({ active: true, currentWindow: true, url: "*://aistudio.google.com/*" });
            if (tabs.length === 0) {
                alert('No active AI Studio tab found. Please navigate to AI Studio and try again.');
                return;
            }
            const tabId = tabs[0].id;
            // The content script will handle the reload and start sequence.
            await browser.scripting.executeScript({
                target: { tabId: tabId },
                function: () => {
                   // This is a more robust way to trigger the updater than message passing.
                   // The content script on the page will see this and trigger its logic.
                   browser.storage.local.set({ 'startUpdaterMode': true }).then(() => {
                        window.location.reload();
                   });
                }
            });
            alert('Updater mode signal sent to the active AI Studio tab. It will now reload and begin calibration.');

        } catch (e) {
            console.error("Failed to launch updater mode:", e);
            alert("An error occurred. Check the browser console for details.");
        }
    });


    // --- Import / Export ---
    
    exportBtn.addEventListener('click', async () => {
        const data = await browser.storage.local.get([PROCEDURE_KEY, CACHE_KEY]);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        a.href = url;
        a.download = `ai-studio-library-backup-${timestamp}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert('Data exported!');
    });

    importFile.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (data[PROCEDURE_KEY] || data[CACHE_KEY]) {
                    await browser.storage.local.clear(); // Clear old data first
                    await browser.storage.local.set(data);
                    alert('Data imported successfully! Reloading options page.');
                    location.reload();
                } else {
                    throw new Error('File does not contain valid keys.');
                }
            } catch (error) {
                alert(`Error importing file: ${error.message}`);
            }
        };
        reader.readAsText(file);
    });

});
