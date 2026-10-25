fn main() {
    let d = nexus_model::repo_tools::definitions_for(nexus_model::request::ToolProfile::RepoCodeV1);
    println!("{}", serde_json::to_string(&d).unwrap());
}
