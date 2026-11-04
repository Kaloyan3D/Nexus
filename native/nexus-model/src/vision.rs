//! M4.1: whether a remote model can be shown an image.
//!
//! Nexus sends a screenshot as an image ONLY to a model it knows can read one, and says so
//! plainly otherwise. The answer is a property of the sealed remote model id, never of text the
//! model or a web page produced. Unknown ids are `Unknown`, which is treated like `No`: the tool
//! result then states that the image was not delivered, and the model must not claim to have seen
//! the page.

/// What Nexus knows about a model's image input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageInput {
    /// The model's published capabilities include image input (Registry `supportsVision: true`).
    Yes,
    /// The model is text-only.
    No,
    /// Not in the table: not trusted with an image.
    Unknown,
}

impl ImageInput {
    pub fn accepts_images(self) -> bool {
        self == ImageInput::Yes
    }
}

/// Remote model ids known to read images. Mirrors `config/model-registry.json` (`supportsVision`).
const VISION_MODELS: &[&str] = &["muse-spark-1.3-contributor"];
/// Remote model ids known to be text-only.
const TEXT_ONLY_MODELS: &[&str] = &["deepseek-v4-flash", "deepseek-v4-pro"];

/// The image-input capability of `remote_model_id`.
pub fn image_input(remote_model_id: &str) -> ImageInput {
    image_input_with(remote_model_id, &[])
}

/// As [`image_input`], plus ids the operator declared to take images. A declaration can only ADD
/// vision; it cannot override a model the table knows to be text-only.
pub fn image_input_with(remote_model_id: &str, operator_vision: &[String]) -> ImageInput {
    if TEXT_ONLY_MODELS.contains(&remote_model_id) {
        ImageInput::No
    } else if VISION_MODELS.contains(&remote_model_id)
        || operator_vision.iter().any(|m| m == remote_model_id)
    {
        ImageInput::Yes
    } else {
        ImageInput::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_vision_models_accept_images() {
        assert!(image_input("muse-spark-1.3-contributor").accepts_images());
        assert_eq!(image_input("deepseek-v4-flash"), ImageInput::No);
        assert!(!image_input("some-new-model").accepts_images());
        assert_eq!(image_input(""), ImageInput::Unknown);
    }

    #[test]
    fn an_operator_can_add_vision_but_never_to_a_known_text_only_model() {
        let ops = vec![
            "new-vision-model".to_owned(),
            "deepseek-v4-flash".to_owned(),
        ];
        assert_eq!(image_input_with("new-vision-model", &ops), ImageInput::Yes);
        assert_eq!(
            image_input_with("new-vision-model", &[]),
            ImageInput::Unknown
        );
        assert_eq!(image_input_with("deepseek-v4-flash", &ops), ImageInput::No);
        assert_eq!(
            image_input_with("muse-spark-1.3-contributor", &[]),
            ImageInput::Yes
        );
    }
}
