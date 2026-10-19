//! Name matching shared by the screen reader and the model (also built for the browser).

/// Lower-case ASCII letters only: "Rúben Dias" → "rubendias", "O'Reilly" → "oreilly".
pub fn normalise_name(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' | 'ć' | 'č' => 'c',
            'ñ' | 'ń' => 'n',
            'š' | 'ś' => 's',
            'ž' | 'ź' | 'ż' => 'z',
            'ý' | 'ÿ' => 'y',
            'ł' => 'l',
            'ğ' => 'g',
            'ı' => 'i',
            'ş' | 'ș' => 's',
            'ð' | 'đ' => 'd',
            'ř' => 'r',
            'ț' | 'ţ' => 't',
            'ę' | 'ė' | 'ě' => 'e',
            'ō' => 'o',
            'ă' => 'a',
            c => c,
        })
        .flat_map(|c| match c {
            'ß' => vec!['s', 's'],
            'æ' => vec!['a', 'e'],
            'œ' => vec!['o', 'e'],
            c => vec![c],
        })
        .filter(|c| c.is_ascii_lowercase())
        .collect()
}
