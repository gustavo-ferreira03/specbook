-- "act" behaved like "propose" once verified repairs became automatic for every project.
UPDATE `project_stewards` SET `autonomy` = 'propose' WHERE `autonomy` = 'act';
