param(
    [string]$PayloadB64 = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

function Emit([string]$kind, [string]$text) {
    $safe = ([string]$text) -replace '[\r\n]+', ' '
    [Console]::WriteLine("$kind`:$safe")
    [Console]::Out.Flush()
}

try {
    $culture = $null
    foreach ($name in @('en-US', 'en-GB')) {
        try {
            $candidate = [System.Globalization.CultureInfo]::GetCultureInfo($name)
            $match = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
                Where-Object { $_.Culture.Name -eq $candidate.Name }
            if ($match) {
                $culture = $candidate
                break
            }
        } catch {}
    }

    if ($culture) {
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine $culture
    } else {
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    }

    $engine.MaxAlternates = 3
    $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(30)
    $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(400)
    $engine.BabbleTimeout = [TimeSpan]::FromSeconds(3)
    $engine.SetInputToDefaultAudioDevice()

    $payload = @{ words = @(); sentences = @() }
    if ($PayloadB64) {
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
        $payload = ConvertFrom-Json $json
    }

    $words = @()
    if ($payload.words) { $words = @($payload.words) }
    $sentences = @()
    if ($payload.sentences) { $sentences = @($payload.sentences) }

    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))

    if ($words.Count -gt 0) {
        $choices = New-Object System.Speech.Recognition.Choices
        foreach ($word in $words) {
            $clean = [string]$word
            if ($clean) { [void]$choices.Add($clean) }
        }
        $wordBuilder = New-Object System.Speech.Recognition.GrammarBuilder
        $wordBuilder.Culture = $engine.RecognizerInfo.Culture
        $wordBuilder.Append($choices, 1, 8)
        $wordGrammar = New-Object System.Speech.Recognition.Grammar $wordBuilder
        $wordGrammar.Name = 'lesson-words'
        $engine.LoadGrammar($wordGrammar)
    }

    foreach ($sentence in $sentences) {
        $text = ([string]$sentence).Trim()
        if (-not $text) { continue }
        $sentenceBuilder = New-Object System.Speech.Recognition.GrammarBuilder
        $sentenceBuilder.Culture = $engine.RecognizerInfo.Culture
        $sentenceBuilder.Append($text)
        $sentenceGrammar = New-Object System.Speech.Recognition.Grammar $sentenceBuilder
        $sentenceGrammar.Name = 'lesson-sentence'
        $engine.LoadGrammar($sentenceGrammar)
    }

    Emit 'READY' 'ok'

    while ($true) {
        $result = $engine.Recognize()
        if ($result -and $result.Text) {
            Emit 'FINAL' $result.Text
        }
    }
} catch {
    Emit 'ERROR' $_.Exception.Message
    exit 1
}
